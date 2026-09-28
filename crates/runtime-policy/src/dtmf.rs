use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DtmfAction {
    HumanTransfer { destination_label: Option<String> },
    Back,
    RepeatMenu,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DtmfBinding {
    pub sequence: String,
    pub action: DtmfAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DtmfError {
    #[error("invalid DTMF digit")]
    InvalidDigit,
    #[error("invalid DTMF binding {0}")]
    InvalidBinding(String),
}

const MAX_SEQUENCE_LENGTH: usize = 4;

pub fn parse_digit(input: &str) -> Result<char, DtmfError> {
    let trimmed = input.trim();
    let mut chars = trimmed.chars();
    let digit = chars.next().ok_or(DtmfError::InvalidDigit)?;
    if chars.next().is_some() {
        return Err(DtmfError::InvalidDigit);
    }
    let normalized = digit.to_ascii_uppercase();
    if normalized.is_ascii_digit() || matches!(normalized, '*' | '#' | 'A' | 'B' | 'C' | 'D') {
        Ok(normalized)
    } else {
        Err(DtmfError::InvalidDigit)
    }
}

#[derive(Debug)]
pub struct DtmfMatcher {
    bindings: Vec<DtmfBinding>,
    buffer: String,
    last_digit_at: Option<Instant>,
    inter_digit_timeout: Duration,
}

impl DtmfMatcher {
    pub fn new(bindings: Vec<DtmfBinding>, inter_digit_timeout: Duration) -> Result<Self, DtmfError> {
        for binding in &bindings {
            let valid = !binding.sequence.is_empty()
                && binding.sequence.chars().count() <= MAX_SEQUENCE_LENGTH
                && binding.sequence.chars().all(|digit| parse_digit(&digit.to_string()).is_ok());
            if !valid {
                return Err(DtmfError::InvalidBinding(binding.sequence.clone()));
            }
        }
        let mut sequences: Vec<&str> = bindings.iter().map(|binding| binding.sequence.as_str()).collect();
        sequences.sort_unstable();
        if sequences.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(DtmfError::InvalidBinding("duplicate sequence".into()));
        }
        Ok(Self { bindings, buffer: String::new(), last_digit_at: None, inter_digit_timeout })
    }

    fn is_prefix(&self, candidate: &str) -> bool {
        self.bindings.iter().any(|binding| binding.sequence.starts_with(candidate))
    }

    pub fn push(&mut self, digit: char, at: Instant) -> Option<DtmfAction> {
        if self.last_digit_at.is_some_and(|last| at.saturating_duration_since(last) > self.inter_digit_timeout) {
            self.buffer.clear();
        }
        self.last_digit_at = Some(at);
        self.buffer.push(digit);
        if !self.is_prefix(&self.buffer) {
            self.buffer.clear();
            self.buffer.push(digit);
            if !self.is_prefix(&self.buffer) {
                self.buffer.clear();
                return None;
            }
        }
        let matched = self.bindings.iter().find(|binding| binding.sequence == self.buffer).map(|binding| binding.action.clone());
        let longer_exists = self.bindings.iter().any(|binding| binding.sequence.len() > self.buffer.len() && binding.sequence.starts_with(&self.buffer));
        if matched.is_some() && !longer_exists {
            self.buffer.clear();
        }
        if longer_exists { None } else { matched }
    }

    pub fn flush_on_timeout(&mut self, now: Instant) -> Option<DtmfAction> {
        let expired = self.last_digit_at.is_some_and(|last| now.saturating_duration_since(last) > self.inter_digit_timeout);
        if !expired || self.buffer.is_empty() {
            return None;
        }
        let matched = self.bindings.iter().find(|binding| binding.sequence == self.buffer).map(|binding| binding.action.clone());
        self.buffer.clear();
        matched
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn matcher() -> Result<DtmfMatcher, DtmfError> {
        DtmfMatcher::new(
            vec![
                DtmfBinding { sequence: "###".into(), action: DtmfAction::HumanTransfer { destination_label: None } },
                DtmfBinding { sequence: "0".into(), action: DtmfAction::HumanTransfer { destination_label: Some("front-desk".into()) } },
                DtmfBinding { sequence: "*".into(), action: DtmfAction::Back },
                DtmfBinding { sequence: "9".into(), action: DtmfAction::RepeatMenu },
                DtmfBinding { sequence: "99".into(), action: DtmfAction::Back },
            ],
            Duration::from_secs(3),
        )
    }

    #[test]
    fn parses_only_valid_digits() {
        assert_eq!(parse_digit(" # "), Ok('#'));
        assert_eq!(parse_digit("a"), Ok('A'));
        assert_eq!(parse_digit("5"), Ok('5'));
        assert_eq!(parse_digit("55"), Err(DtmfError::InvalidDigit));
        assert_eq!(parse_digit(""), Err(DtmfError::InvalidDigit));
        assert_eq!(parse_digit("x"), Err(DtmfError::InvalidDigit));
    }

    #[test]
    fn matches_multi_digit_sequences_and_resets_on_timeout() -> Result<(), DtmfError> {
        let mut matcher = matcher()?;
        let start = Instant::now();
        assert_eq!(matcher.push('#', start), None);
        assert_eq!(matcher.push('#', start + Duration::from_millis(400)), None);
        assert_eq!(matcher.push('#', start + Duration::from_millis(800)), Some(DtmfAction::HumanTransfer { destination_label: None }));
        assert_eq!(matcher.push('#', start + Duration::from_secs(10)), None);
        assert_eq!(matcher.push('#', start + Duration::from_secs(20)), None);
        assert_eq!(matcher.push('0', start + Duration::from_secs(20)), Some(DtmfAction::HumanTransfer { destination_label: Some("front-desk".into()) }));
        Ok(())
    }

    #[test]
    fn resolves_ambiguous_prefixes_after_the_inter_digit_timeout() -> Result<(), DtmfError> {
        let mut matcher = matcher()?;
        let start = Instant::now();
        assert_eq!(matcher.push('9', start), None);
        assert_eq!(matcher.flush_on_timeout(start + Duration::from_secs(4)), Some(DtmfAction::RepeatMenu));
        assert_eq!(matcher.push('9', start + Duration::from_secs(5)), None);
        assert_eq!(matcher.push('9', start + Duration::from_secs(5) + Duration::from_millis(300)), Some(DtmfAction::Back));
        Ok(())
    }

    #[test]
    fn rejects_invalid_and_duplicate_bindings() {
        let invalid = DtmfMatcher::new(vec![DtmfBinding { sequence: "12345".into(), action: DtmfAction::Back }], Duration::from_secs(1));
        assert!(invalid.is_err());
        let duplicate = DtmfMatcher::new(
            vec![DtmfBinding { sequence: "0".into(), action: DtmfAction::Back }, DtmfBinding { sequence: "0".into(), action: DtmfAction::RepeatMenu }],
            Duration::from_secs(1),
        );
        assert!(duplicate.is_err());
    }

    proptest! {
        #[test]
        fn arbitrary_input_never_panics(inputs in proptest::collection::vec(".{0,4}", 0..50)) {
            let mut matcher = match matcher() { Ok(matcher) => matcher, Err(_) => return Ok(()) };
            let start = Instant::now();
            for (index, input) in inputs.iter().enumerate() {
                if let Ok(digit) = parse_digit(input) {
                    let offset = u64::try_from(index).unwrap_or(0) * 500;
                    let _ = matcher.push(digit, start + Duration::from_millis(offset));
                }
            }
            prop_assert!(matcher.buffer.len() <= MAX_SEQUENCE_LENGTH);
        }
    }
}
