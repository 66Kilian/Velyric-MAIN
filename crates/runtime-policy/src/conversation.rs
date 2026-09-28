use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConversationState {
    Greeting,
    Discovery,
    Identity,
    ActionPreview,
    ConfirmationGate,
    ToolExecution,
    ResultConfirmation,
    FollowUp,
    Handoff,
    SafeFailure,
    Closing,
    End,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ConversationEvent {
    DisclosureDelivered,
    IntentDetected { requires_identity: bool },
    IdentityVerified,
    ActionPrepared,
    CallerConfirmed,
    CallerDeclined,
    ToolCompleted { success: bool },
    ResultAcknowledged,
    FurtherRequest,
    NoFurtherRequests,
    HandoffRequested,
    UnrecoverableError,
    Hangup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("conversation state {from:?} does not accept {event:?}")]
pub struct TransitionError {
    pub from: ConversationState,
    pub event: ConversationEvent,
}

impl ConversationState {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::End)
    }

    #[must_use]
    pub const fn allows_write_tools(self) -> bool {
        matches!(self, Self::ToolExecution)
    }
}

pub fn transition(from: ConversationState, event: ConversationEvent) -> Result<ConversationState, TransitionError> {
    use ConversationEvent as E;
    use ConversationState as S;

    let next = match (from, event) {
        (S::End, _) => None,
        (_, E::Hangup) => Some(S::End),
        (S::Closing, _) => None,
        (_, E::UnrecoverableError) => Some(S::SafeFailure),
        (S::Handoff, E::NoFurtherRequests) => Some(S::Closing),
        (S::Handoff, E::FurtherRequest) => Some(S::Discovery),
        (S::Handoff, _) => None,
        (_, E::HandoffRequested) => Some(S::Handoff),
        (S::Greeting, E::DisclosureDelivered) => Some(S::Discovery),
        (S::Discovery, E::IntentDetected { requires_identity: true }) => Some(S::Identity),
        (S::Discovery, E::IntentDetected { requires_identity: false }) | (S::Identity, E::IdentityVerified) => {
            Some(S::ActionPreview)
        }
        (S::ActionPreview, E::ActionPrepared) => Some(S::ConfirmationGate),
        (S::ConfirmationGate, E::CallerConfirmed) => Some(S::ToolExecution),
        (S::ConfirmationGate | S::ActionPreview | S::Identity, E::CallerDeclined) => Some(S::Discovery),
        (S::ToolExecution, E::ToolCompleted { success: true }) => Some(S::ResultConfirmation),
        (S::ToolExecution, E::ToolCompleted { success: false }) => Some(S::SafeFailure),
        (S::ResultConfirmation, E::ResultAcknowledged) => Some(S::FollowUp),
        (S::FollowUp | S::SafeFailure, E::FurtherRequest) => Some(S::Discovery),
        (S::FollowUp | S::SafeFailure | S::Discovery, E::NoFurtherRequests) => Some(S::Closing),
        _ => None,
    };
    next.ok_or(TransitionError { from, event })
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn walk(events: &[ConversationEvent]) -> Result<ConversationState, TransitionError> {
        events.iter().try_fold(ConversationState::Greeting, |state, event| transition(state, *event))
    }

    #[test]
    fn happy_booking_path_requires_disclosure_preview_and_confirmation() -> Result<(), TransitionError> {
        use ConversationEvent as E;
        let end = walk(&[
            E::DisclosureDelivered,
            E::IntentDetected { requires_identity: true },
            E::IdentityVerified,
            E::ActionPrepared,
            E::CallerConfirmed,
            E::ToolCompleted { success: true },
            E::ResultAcknowledged,
            E::NoFurtherRequests,
            E::Hangup,
        ])?;
        assert_eq!(end, ConversationState::End);
        Ok(())
    }

    #[test]
    fn cannot_skip_disclosure_or_confirmation() {
        use ConversationEvent as E;
        assert!(transition(ConversationState::Greeting, E::IntentDetected { requires_identity: false }).is_err());
        assert!(transition(ConversationState::ActionPreview, E::CallerConfirmed).is_err());
        assert!(transition(ConversationState::Discovery, E::ToolCompleted { success: true }).is_err());
        assert!(transition(ConversationState::End, E::HandoffRequested).is_err());
    }

    #[test]
    fn handoff_and_failures_are_reachable_from_active_states() -> Result<(), TransitionError> {
        use ConversationEvent as E;
        assert_eq!(transition(ConversationState::Greeting, E::HandoffRequested)?, ConversationState::Handoff);
        assert_eq!(transition(ConversationState::ToolExecution, E::ToolCompleted { success: false })?, ConversationState::SafeFailure);
        assert_eq!(transition(ConversationState::SafeFailure, E::HandoffRequested)?, ConversationState::Handoff);
        assert_eq!(transition(ConversationState::Handoff, E::FurtherRequest)?, ConversationState::Discovery);
        assert_eq!(transition(ConversationState::ConfirmationGate, E::CallerDeclined)?, ConversationState::Discovery);
        Ok(())
    }

    fn event_strategy() -> impl Strategy<Value = ConversationEvent> {
        use ConversationEvent as E;
        prop_oneof![
            Just(E::DisclosureDelivered),
            any::<bool>().prop_map(|requires_identity| E::IntentDetected { requires_identity }),
            Just(E::IdentityVerified),
            Just(E::ActionPrepared),
            Just(E::CallerConfirmed),
            Just(E::CallerDeclined),
            any::<bool>().prop_map(|success| E::ToolCompleted { success }),
            Just(E::ResultAcknowledged),
            Just(E::FurtherRequest),
            Just(E::NoFurtherRequests),
            Just(E::HandoffRequested),
            Just(E::UnrecoverableError),
            Just(E::Hangup),
        ]
    }

    proptest! {
        #[test]
        fn write_tools_are_only_reachable_through_an_explicit_confirmation(events in proptest::collection::vec(event_strategy(), 0..60)) {
            let mut state = ConversationState::Greeting;
            let mut disclosed = false;
            for event in events {
                let previous = state;
                if let Ok(next) = transition(state, event) {
                    if previous == ConversationState::Greeting && next == ConversationState::Discovery {
                        disclosed = true;
                    }
                    if next == ConversationState::ToolExecution {
                        prop_assert_eq!(previous, ConversationState::ConfirmationGate);
                        prop_assert_eq!(event, ConversationEvent::CallerConfirmed);
                        prop_assert!(disclosed);
                    }
                    state = next;
                }
            }
            if state == ConversationState::End {
                prop_assert!(transition(state, ConversationEvent::FurtherRequest).is_err());
            }
        }
    }
}
