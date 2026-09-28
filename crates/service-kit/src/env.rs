use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;

use thiserror::Error;
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Environment {
    Local,
    Ci,
    Staging,
    Production,
}

impl Environment {
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "local" => Some(Self::Local),
            "ci" => Some(Self::Ci),
            "staging" => Some(Self::Staging),
            "production" => Some(Self::Production),
            _ => None,
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Ci => "ci",
            Self::Staging => "staging",
            Self::Production => "production",
        }
    }

    #[must_use]
    pub const fn is_deployed(self) -> bool {
        matches!(self, Self::Staging | Self::Production)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderMode {
    Simulator,
    Sandbox,
    Live,
}

impl ProviderMode {
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "simulator" => Some(Self::Simulator),
            "sandbox" => Some(Self::Sandbox),
            "live" => Some(Self::Live),
            _ => None,
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Simulator => "simulator",
            Self::Sandbox => "sandbox",
            Self::Live => "live",
        }
    }

    #[must_use]
    pub const fn allowed_in(self, environment: Environment) -> bool {
        matches!(
            (environment, self),
            (Environment::Local, Self::Simulator | Self::Sandbox)
                | (Environment::Ci, Self::Simulator)
                | (Environment::Staging, Self::Sandbox)
                | (Environment::Production, Self::Live)
        )
    }

    #[must_use]
    pub const fn default_for(environment: Environment) -> Self {
        match environment {
            Environment::Local | Environment::Ci => Self::Simulator,
            Environment::Staging => Self::Sandbox,
            Environment::Production => Self::Live,
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub enum SecretSource {
    Inline(String),
    Arn(String),
}

impl fmt::Debug for SecretSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Inline(_) => formatter.write_str("SecretSource::Inline(redacted)"),
            Self::Arn(arn) => write!(formatter, "SecretSource::Arn({arn})"),
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
#[error("invalid configuration: {}", .0.join("; "))]
pub struct ConfigError(pub Vec<String>);

#[must_use]
pub fn valid_token(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

#[must_use]
pub fn valid_region(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == 3
        && parts.first().is_some_and(|part| part.len() == 2 && part.bytes().all(|byte| byte.is_ascii_lowercase()))
        && parts.get(1).is_some_and(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_lowercase()))
        && parts.get(2).is_some_and(|part| part.len() == 1 && part.bytes().all(|byte| byte.is_ascii_digit()))
}

pub struct EnvReader<'a> {
    env: &'a HashMap<String, String>,
    issues: Vec<String>,
}

impl<'a> EnvReader<'a> {
    #[must_use]
    pub const fn new(env: &'a HashMap<String, String>) -> Self {
        Self { env, issues: Vec::new() }
    }

    pub fn issue(&mut self, message: impl Into<String>) {
        self.issues.push(message.into());
    }

    #[must_use]
    pub fn has_issues(&self) -> bool {
        !self.issues.is_empty()
    }

    #[must_use]
    pub fn into_error(self) -> ConfigError {
        ConfigError(self.issues)
    }

    #[must_use]
    pub fn optional(&self, name: &str) -> Option<String> {
        self.env.get(name).map(|value| value.trim().to_owned()).filter(|value| !value.is_empty())
    }

    pub fn required(&mut self, name: &str) -> Option<String> {
        let value = self.optional(name);
        if value.is_none() {
            self.issue(format!("{name} is required"));
        }
        value
    }

    pub fn environment(&mut self) -> Option<Environment> {
        let raw = self.required("VELYRIC_ENV")?;
        let parsed = Environment::parse(&raw);
        if parsed.is_none() {
            self.issue("VELYRIC_ENV must be one of local, ci, staging, production");
        }
        parsed
    }

    pub fn region(&mut self) -> Option<String> {
        let region = self.required("VELYRIC_AWS_REGION")?;
        if valid_region(&region) {
            Some(region)
        } else {
            self.issue("VELYRIC_AWS_REGION must be an AWS region such as eu-central-1");
            None
        }
    }

    pub fn number<T>(&mut self, name: &str, default: T, min: T, max: T) -> T
    where
        T: FromStr + PartialOrd + Copy + fmt::Display,
    {
        match self.optional(name) {
            None => default,
            Some(raw) => match raw.parse::<T>() {
                Ok(value) if value >= min && value <= max => value,
                _ => {
                    self.issue(format!("{name} must be an integer between {min} and {max}"));
                    default
                }
            },
        }
    }

    pub fn url(&mut self, name: &str, raw: Option<String>) -> Option<Url> {
        let raw = raw?;
        match Url::parse(&raw) {
            Ok(url) if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() => Some(url),
            _ => {
                self.issue(format!("{name} must be an absolute http(s) URL"));
                None
            }
        }
    }

    pub fn secret(&mut self, name: &str, environment: Option<Environment>, required: bool) -> Option<SecretSource> {
        let inline = self.optional(&format!("{name}_SECRET"));
        let arn = self.optional(&format!("{name}_SECRET_ARN"));
        match (inline, arn) {
            (Some(_), Some(_)) => {
                self.issue(format!("only one of {name}_SECRET and {name}_SECRET_ARN may be set"));
                None
            }
            (Some(value), None) => {
                if let Some(environment) = environment.filter(|environment| environment.is_deployed()) {
                    self.issue(format!("{name}_SECRET is not allowed in {}; use {name}_SECRET_ARN", environment.as_str()));
                    None
                } else {
                    Some(SecretSource::Inline(value))
                }
            }
            (None, Some(arn)) => {
                if arn.starts_with("arn:") && arn.contains(":secretsmanager:") {
                    Some(SecretSource::Arn(arn))
                } else {
                    self.issue(format!("{name}_SECRET_ARN must be a Secrets Manager ARN"));
                    None
                }
            }
            (None, None) => {
                if required {
                    self.issue(format!("{name}_SECRET or {name}_SECRET_ARN is required"));
                }
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect()
    }

    #[test]
    fn secrets_follow_the_inline_versus_arn_environment_rules() {
        let values = env(&[
            ("A_SECRET", "value"),
            ("B_SECRET_ARN", "arn:aws:secretsmanager:eu-central-1:1:secret:b"),
            ("C_SECRET", "x"),
            ("C_SECRET_ARN", "arn:aws:secretsmanager:eu-central-1:1:secret:c"),
            ("D_SECRET_ARN", "not-an-arn"),
        ]);
        let mut reader = EnvReader::new(&values);
        assert_eq!(reader.secret("A", Some(Environment::Local), true), Some(SecretSource::Inline("value".into())));
        assert_eq!(reader.secret("A", Some(Environment::Production), true), None);
        assert!(matches!(reader.secret("B", Some(Environment::Production), true), Some(SecretSource::Arn(_))));
        assert_eq!(reader.secret("C", Some(Environment::Local), true), None);
        assert_eq!(reader.secret("D", Some(Environment::Local), true), None);
        assert_eq!(reader.secret("E", Some(Environment::Local), false), None);
        assert_eq!(reader.secret("F", Some(Environment::Local), true), None);
        assert_eq!(reader.into_error().0.len(), 4);
        assert_eq!(format!("{:?}", SecretSource::Inline("secret".into())), "SecretSource::Inline(redacted)");
    }

    #[test]
    fn numbers_regions_and_environments_are_validated() {
        let values = env(&[("VELYRIC_ENV", "prod"), ("VELYRIC_AWS_REGION", "eu-central-1"), ("PORT", "70000"), ("WORKERS", "4")]);
        let mut reader = EnvReader::new(&values);
        assert_eq!(reader.environment(), None);
        assert_eq!(reader.region().as_deref(), Some("eu-central-1"));
        assert_eq!(reader.number("PORT", 7_100_u32, 1, 65_535), 7_100);
        assert_eq!(reader.number("WORKERS", 1_u32, 1, 64), 4);
        assert!(reader.has_issues());
        assert!(ProviderMode::Live.allowed_in(Environment::Production));
        assert!(!ProviderMode::Simulator.allowed_in(Environment::Staging));
        assert!(valid_token("gpt-5.6-luna", 100));
        assert!(!valid_region("europe"));
    }
}
