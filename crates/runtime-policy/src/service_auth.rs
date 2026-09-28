use std::collections::{HashMap, HashSet};

use base64::Engine;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, decode_header, encode};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use time::OffsetDateTime;
use uuid::Uuid;

pub const MAX_LIFETIME_SECONDS: i64 = 300;
pub const CLOCK_SKEW_SECONDS: u64 = 30;

#[derive(Debug, Error)]
pub enum ServiceAuthError {
    #[error("service token is invalid: {0}")]
    Invalid(String),
    #[error("service token is missing scopes: {0}")]
    MissingScopes(String),
    #[error("service key material is invalid: {0}")]
    Key(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServiceClaims {
    pub iss: String,
    pub sub: String,
    pub aud: String,
    pub iat: i64,
    pub nbf: i64,
    pub exp: i64,
    pub jti: String,
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedService {
    pub issuer: String,
    pub scopes: HashSet<String>,
    pub tenant_id: Option<Uuid>,
    pub jti: Uuid,
    pub expires_at: i64,
}

pub struct ServiceSigner {
    issuer: String,
    kid: String,
    key: EncodingKey,
}

impl ServiceSigner {
    pub fn from_pkcs8_pem(issuer: &str, kid: &str, pem: &[u8]) -> Result<Self, ServiceAuthError> {
        let key = EncodingKey::from_ed_pem(pem).map_err(|error| ServiceAuthError::Key(error.to_string()))?;
        Ok(Self { issuer: issuer.to_owned(), kid: kid.to_owned(), key })
    }

    pub fn sign(&self, audience: &str, scopes: &[&str], tenant_id: Option<Uuid>, now: OffsetDateTime) -> Result<String, ServiceAuthError> {
        if scopes.is_empty() {
            return Err(ServiceAuthError::Invalid("scopes must not be empty".into()));
        }
        let issued_at = now.unix_timestamp();
        let claims = ServiceClaims {
            iss: self.issuer.clone(),
            sub: self.issuer.clone(),
            aud: audience.to_owned(),
            iat: issued_at,
            nbf: issued_at,
            exp: issued_at + MAX_LIFETIME_SECONDS,
            jti: Uuid::now_v7().to_string(),
            scope: scopes.join(" "),
            tenant_id: tenant_id.map(|id| id.to_string()),
        };
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some(self.kid.clone());
        header.typ = Some("JWT".into());
        encode(&header, &claims, &self.key).map_err(|error| ServiceAuthError::Invalid(error.to_string()))
    }
}

#[derive(Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

#[derive(Deserialize)]
struct Jwk {
    kty: String,
    crv: Option<String>,
    x: Option<String>,
    kid: Option<String>,
}

pub struct ServiceVerifier {
    audience: String,
    keys: HashMap<String, DecodingKey>,
}

impl ServiceVerifier {
    pub fn from_jwks_json(audience: &str, jwks: &str) -> Result<Self, ServiceAuthError> {
        let parsed: Jwks = serde_json::from_str(jwks).map_err(|error| ServiceAuthError::Key(error.to_string()))?;
        let mut keys = HashMap::new();
        for jwk in parsed.keys {
            if jwk.kty != "OKP" || jwk.crv.as_deref() != Some("Ed25519") {
                continue;
            }
            let (Some(kid), Some(x)) = (jwk.kid, jwk.x) else {
                return Err(ServiceAuthError::Key("Ed25519 JWK requires kid and x".into()));
            };
            let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(x.as_bytes())
                .map_err(|error| ServiceAuthError::Key(error.to_string()))?;
            if raw.len() != 32 {
                return Err(ServiceAuthError::Key("Ed25519 public key must be 32 bytes".into()));
            }
            keys.insert(kid, DecodingKey::from_ed_components(&x).map_err(|error| ServiceAuthError::Key(error.to_string()))?);
        }
        if keys.is_empty() {
            return Err(ServiceAuthError::Key("JWKS contains no Ed25519 keys".into()));
        }
        Ok(Self { audience: audience.to_owned(), keys })
    }

    pub fn verify(&self, token: &str, required_scopes: &[&str]) -> Result<VerifiedService, ServiceAuthError> {
        let header = decode_header(token).map_err(|error| ServiceAuthError::Invalid(error.to_string()))?;
        if header.alg != Algorithm::EdDSA {
            return Err(ServiceAuthError::Invalid("unexpected algorithm".into()));
        }
        let kid = header.kid.ok_or_else(|| ServiceAuthError::Invalid("missing kid".into()))?;
        let key = self.keys.get(&kid).ok_or_else(|| ServiceAuthError::Invalid("unknown kid".into()))?;
        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.set_audience(&[self.audience.as_str()]);
        validation.leeway = CLOCK_SKEW_SECONDS;
        validation.validate_nbf = true;
        validation.set_required_spec_claims(&["exp", "nbf", "iat", "aud", "iss", "sub"]);
        let claims = decode::<ServiceClaims>(token, key, &validation)
            .map_err(|error| ServiceAuthError::Invalid(error.to_string()))?
            .claims;
        if claims.iss != claims.sub {
            return Err(ServiceAuthError::Invalid("issuer and subject differ".into()));
        }
        if claims.exp - claims.iat > MAX_LIFETIME_SECONDS {
            return Err(ServiceAuthError::Invalid("lifetime exceeds maximum".into()));
        }
        let jti = Uuid::parse_str(&claims.jti).map_err(|_| ServiceAuthError::Invalid("jti must be a UUID".into()))?;
        let tenant_id = claims
            .tenant_id
            .as_deref()
            .map(Uuid::parse_str)
            .transpose()
            .map_err(|_| ServiceAuthError::Invalid("tenant_id must be a UUID".into()))?;
        let scopes: HashSet<String> = claims.scope.split(' ').filter(|scope| !scope.is_empty()).map(str::to_owned).collect();
        let missing: Vec<&str> = required_scopes.iter().copied().filter(|scope| !scopes.contains(*scope)).collect();
        if !missing.is_empty() {
            return Err(ServiceAuthError::MissingScopes(missing.join(" ")));
        }
        Ok(VerifiedService { issuer: claims.iss, scopes, tenant_id, jti, expires_at: claims.exp })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use ed25519_dalek::pkcs8::EncodePrivateKey;
    use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    fn keypair(seed: u8) -> Result<(String, String), Box<dyn std::error::Error>> {
        let signing = SigningKey::from_bytes(&[seed; 32]);
        let pem = signing.to_pkcs8_pem(LineEnding::LF)?.to_string();
        let x = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signing.verifying_key().as_bytes());
        Ok((pem, x))
    }

    fn jwks(kid: &str, x: &str) -> String {
        serde_json::json!({ "keys": [{ "kty": "OKP", "crv": "Ed25519", "x": x, "kid": kid, "alg": "EdDSA", "use": "sig" }] }).to_string()
    }

    #[test]
    fn round_trips_scoped_tenant_bound_tokens() -> TestResult {
        let (pem, x) = keypair(7)?;
        let signer = ServiceSigner::from_pkcs8_pem("control-api", "control-api-1", pem.as_bytes())?;
        let verifier = ServiceVerifier::from_jwks_json("voice-runtime", &jwks("control-api-1", &x))?;
        let tenant = Uuid::now_v7();
        let token = signer.sign("voice-runtime", &["call.control"], Some(tenant), OffsetDateTime::now_utc())?;
        let verified = verifier.verify(&token, &["call.control"])?;
        assert_eq!(verified.issuer, "control-api");
        assert_eq!(verified.tenant_id, Some(tenant));
        assert!(verified.scopes.contains("call.control"));
        Ok(())
    }

    #[test]
    fn rejects_wrong_audience_missing_scopes_expiry_and_foreign_keys() -> TestResult {
        let (pem, x) = keypair(7)?;
        let (foreign_pem, _) = keypair(9)?;
        let signer = ServiceSigner::from_pkcs8_pem("control-api", "control-api-1", pem.as_bytes())?;
        let forger = ServiceSigner::from_pkcs8_pem("control-api", "control-api-1", foreign_pem.as_bytes())?;
        let verifier = ServiceVerifier::from_jwks_json("voice-runtime", &jwks("control-api-1", &x))?;
        let now = OffsetDateTime::now_utc();

        let wrong_audience = signer.sign("metering-worker", &["call.control"], None, now)?;
        assert!(matches!(verifier.verify(&wrong_audience, &[]), Err(ServiceAuthError::Invalid(_))));

        let scoped = signer.sign("voice-runtime", &["usage.write"], None, now)?;
        assert!(matches!(verifier.verify(&scoped, &["call.control"]), Err(ServiceAuthError::MissingScopes(_))));

        let expired = signer.sign("voice-runtime", &["call.control"], None, now - time::Duration::hours(1))?;
        assert!(matches!(verifier.verify(&expired, &["call.control"]), Err(ServiceAuthError::Invalid(_))));

        let forged = forger.sign("voice-runtime", &["call.control"], None, now)?;
        assert!(matches!(verifier.verify(&forged, &["call.control"]), Err(ServiceAuthError::Invalid(_))));

        let mut tampered = signer.sign("voice-runtime", &["call.control"], None, now)?;
        tampered.push('A');
        assert!(verifier.verify(&tampered, &["call.control"]).is_err());
        Ok(())
    }

    #[test]
    fn rejects_overlong_lifetimes_and_mismatched_subjects() -> TestResult {
        let (pem, x) = keypair(11)?;
        let verifier = ServiceVerifier::from_jwks_json("voice-runtime", &jwks("k1", &x))?;
        let key = EncodingKey::from_ed_pem(pem.as_bytes())?;
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some("k1".into());
        let long_lived = ServiceClaims {
            iss: "control-api".into(),
            sub: "control-api".into(),
            aud: "voice-runtime".into(),
            iat: now,
            nbf: now,
            exp: now + 3_600,
            jti: Uuid::now_v7().to_string(),
            scope: "call.control".into(),
            tenant_id: None,
        };
        assert!(verifier.verify(&encode(&header, &long_lived, &key)?, &[]).is_err());
        let spoofed = ServiceClaims { sub: "workflow-worker".into(), exp: now + 60, ..long_lived };
        assert!(verifier.verify(&encode(&header, &spoofed, &key)?, &[]).is_err());
        assert!(ServiceVerifier::from_jwks_json("voice-runtime", r#"{"keys":[]}"#).is_err());
        Ok(())
    }
}
