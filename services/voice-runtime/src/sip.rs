use serde::Deserialize;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SipHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SipCallParties {
    pub dialed_e164: String,
    pub caller_e164: Option<String>,
    pub sip_call_id: Option<String>,
    pub carrier: &'static str,
}

#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
pub enum SipError {
    #[error("the SIP To header is missing")]
    MissingDialedNumber,
    #[error("the SIP To header does not contain a valid E.164 number")]
    InvalidDialedNumber,
}

fn header<'a>(headers: &'a [SipHeader], names: &[&str]) -> Option<&'a str> {
    names.iter().find_map(|name| {
        headers
            .iter()
            .find(|header| header.name.trim().eq_ignore_ascii_case(name))
            .map(|header| header.value.as_str())
    })
}

#[must_use]
pub fn normalize_e164(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let digits_part = trimmed.strip_prefix('+').or_else(|| trimmed.strip_prefix("00")).unwrap_or(trimmed);
    let digits: String = digits_part.chars().filter(|character| !matches!(character, '-' | '.' | ' ' | '(' | ')')).collect();
    if digits.is_empty() || !digits.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    if digits.starts_with('0') || !(7..=15).contains(&digits.len()) {
        return None;
    }
    Some(format!("+{digits}"))
}

#[must_use]
pub fn uri_user_to_e164(value: &str) -> Option<String> {
    let inner = match (value.find('<'), value.rfind('>')) {
        (Some(start), Some(end)) if start < end => &value[start + 1..end],
        _ => value.split(';').next().unwrap_or(value),
    };
    let inner = inner.trim();
    let lowered = inner.to_ascii_lowercase();
    let rest = ["sips:", "sip:", "tel:"]
        .iter()
        .find(|scheme| lowered.starts_with(**scheme))
        .map_or(inner, |scheme| &inner[scheme.len()..]);
    let user = rest.split(['@', ';', '?']).next().unwrap_or_default();
    normalize_e164(user)
}

pub fn parse_parties(headers: &[SipHeader]) -> Result<SipCallParties, SipError> {
    let to = header(headers, &["To", "t"]).ok_or(SipError::MissingDialedNumber)?;
    let dialed_e164 = uri_user_to_e164(to).ok_or(SipError::InvalidDialedNumber)?;
    let caller_e164 = header(headers, &["P-Asserted-Identity"])
        .and_then(uri_user_to_e164)
        .or_else(|| header(headers, &["From", "f"]).and_then(uri_user_to_e164));
    let sip_call_id = header(headers, &["Call-ID", "i"]).map(|value| value.trim().chars().take(200).collect());
    let carrier = if header(headers, &["X-Twilio-CallSid"]).is_some() { "twilio" } else { "telnyx" };
    Ok(SipCallParties { dialed_e164, caller_e164, sip_call_id, carrier })
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn headers(pairs: &[(&str, &str)]) -> Vec<SipHeader> {
        pairs.iter().map(|(name, value)| SipHeader { name: (*name).to_owned(), value: (*value).to_owned() }).collect()
    }

    #[test]
    fn extracts_dialed_and_caller_numbers_from_common_header_shapes() -> Result<(), SipError> {
        let parties = parse_parties(&headers(&[
            ("From", "\"Anna\" <sip:+36301234567@sip.telnyx.com>;tag=9fxced76sl"),
            ("To", "<sip:3612345678@proj_abc.sip.api.openai.com;user=phone>"),
            ("Call-ID", "3848276298220188511@atlanta.example.com"),
        ]))?;
        assert_eq!(parties.dialed_e164, "+3612345678");
        assert_eq!(parties.caller_e164.as_deref(), Some("+36301234567"));
        assert_eq!(parties.sip_call_id.as_deref(), Some("3848276298220188511@atlanta.example.com"));
        assert_eq!(parties.carrier, "telnyx");
        Ok(())
    }

    #[test]
    fn prefers_asserted_identity_and_supports_compact_forms() -> Result<(), SipError> {
        let parties = parse_parties(&headers(&[
            ("f", "<sip:anonymous@anonymous.invalid>"),
            ("P-Asserted-Identity", "<tel:+4915123456789>"),
            ("t", "sip:+4930123456@example.com"),
            ("X-Twilio-CallSid", "CA123"),
        ]))?;
        assert_eq!(parties.dialed_e164, "+4930123456");
        assert_eq!(parties.caller_e164.as_deref(), Some("+4915123456789"));
        assert_eq!(parties.carrier, "twilio");
        Ok(())
    }

    #[test]
    fn rejects_missing_or_invalid_dialed_numbers_and_anonymous_callers() {
        assert_eq!(parse_parties(&headers(&[("From", "<sip:+36301234567@x>")])), Err(SipError::MissingDialedNumber));
        assert_eq!(parse_parties(&headers(&[("To", "<sip:reception@x>")])), Err(SipError::InvalidDialedNumber));
        assert_eq!(uri_user_to_e164("<sip:anonymous@anonymous.invalid>"), None);
        assert_eq!(normalize_e164("0036 1 234 5678"), Some("+3612345678".to_owned()));
        assert_eq!(normalize_e164("+0361234567"), None);
        assert_eq!(normalize_e164("+1234567890123456"), None);
    }

    proptest! {
        #[test]
        fn normalized_numbers_always_match_the_e164_contract(input in ".{0,40}") {
            if let Some(value) = normalize_e164(&input) {
                let digits = &value[1..];
                prop_assert!(value.starts_with('+'));
                prop_assert!(digits.chars().all(|character| character.is_ascii_digit()));
                prop_assert!((7..=15).contains(&digits.len()));
                prop_assert!(!digits.starts_with('0'));
            }
            let _ = uri_user_to_e164(&input);
        }
    }
}
