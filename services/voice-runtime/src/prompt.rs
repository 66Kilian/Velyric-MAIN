use std::fmt::Write as _;

use jiff::Timestamp;
use jiff::tz::TimeZone;
use serde_json::{Value, json};
use velyric_call_protocol::{AgentConfig, KNOWLEDGE_SEARCH_TOOL, LanguageConfig, SpecialistConfig, ToolContract};
use velyric_runtime_policy::language::Locale;

use crate::config::ModelCatalog;
use crate::openai::{AcceptRequest, AcceptSession, AudioConfig, AudioOutput, Delegation, FunctionTool, Reasoning, ResponsesDelegation};

pub const META_TOOL_PREFIX: &str = "call_";

pub const END_OUTCOMES: [&str; 11] = [
    "RESOLVED",
    "INFORMATION_PROVIDED",
    "BOOKING_CREATED",
    "BOOKING_CHANGED",
    "BOOKING_CANCELED",
    "WAITLISTED",
    "LEAD_CAPTURED",
    "CALLBACK_REQUESTED",
    "MESSAGE_TAKEN",
    "UNRESOLVED",
    "SPAM",
];

pub const INTENTS: [&str; 9] = ["BOOKING", "SUPPORT", "SALES", "LEAD", "BILLING", "GENERAL_INQUIRY", "HUMAN_REQUEST", "SPAM", "OTHER"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetaTool {
    ReportIntent,
    PrepareAction,
    ConfirmAction,
    RequestHandoff,
    SetLanguage,
    NextStep,
    EndCall,
}

impl MetaTool {
    pub const ALL: [Self; 7] =
        [Self::ReportIntent, Self::PrepareAction, Self::ConfirmAction, Self::RequestHandoff, Self::SetLanguage, Self::NextStep, Self::EndCall];

    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::ReportIntent => "call_report_intent",
            Self::PrepareAction => "call_prepare_action",
            Self::ConfirmAction => "call_confirm_action",
            Self::RequestHandoff => "call_request_handoff",
            Self::SetLanguage => "call_set_language",
            Self::NextStep => "call_next_step",
            Self::EndCall => "call_end",
        }
    }

    #[must_use]
    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|tool| tool.name() == name)
    }

    const fn description(self) -> &'static str {
        match self {
            Self::ReportIntent => "Record the caller's goal as soon as it is clear.",
            Self::PrepareAction => {
                "Prepare a data-changing tool call. Provide the exact tool name, the exact arguments and a short summary that will be read back to the caller for confirmation."
            }
            Self::ConfirmAction => "Record the caller's explicit yes or no answer to the prepared action after the caller has spoken.",
            Self::RequestHandoff => "Transfer the caller to an allowed human destination.",
            Self::SetLanguage => "Record the language the caller is speaking (ISO 639-1 code) whenever it changes.",
            Self::NextStep => "Record whether the caller has a further request after the current one is finished.",
            Self::EndCall => "End the call politely once the conversation is complete.",
        }
    }
}

#[must_use]
pub fn is_write(tool: &ToolContract) -> bool {
    tool.side_effect_class != "READ"
}

#[must_use]
pub fn requires_verified_identity(tool: &ToolContract) -> bool {
    tool.confirmation_policy == "CALLER_CONFIRMATION_WITH_VERIFICATION"
}

#[must_use]
pub fn specialist_for_tool<'a>(config: &'a AgentConfig, tool_name: &str) -> Option<&'a SpecialistConfig> {
    config.specialists.iter().find(|specialist| specialist.enabled && specialist.tool_allowlist.iter().any(|allowed| allowed == tool_name))
}

#[must_use]
pub fn gateway_tools<'a>(config: &AgentConfig, tools: &'a [ToolContract]) -> Vec<&'a ToolContract> {
    tools
        .iter()
        .filter(|tool| tool.active && !tool.name.starts_with(META_TOOL_PREFIX) && specialist_for_tool(config, &tool.name).is_some())
        .collect()
}

#[must_use]
pub fn backend_model<'a>(config: &AgentConfig, models: &'a ModelCatalog) -> (&'a str, Reasoning) {
    let rank = |tier: &str| match tier {
        "FRONTIER" => 3,
        "ESCALATION" => 2,
        "COMPLEX" => 1,
        _ => 0,
    };
    let requested = config.specialists.iter().filter(|specialist| specialist.enabled).map(|specialist| rank(&specialist.model_tier)).max().unwrap_or(0);
    let routing = &config.model_routing;
    let granted = match requested {
        3 | 2 if routing.premium_reasoning_enabled => requested,
        _ if requested >= 1 && routing.complex_escalation_enabled => 1,
        _ => 0,
    };
    match granted {
        3 => (&models.frontier, Reasoning { effort: "high" }),
        2 => (&models.escalation, Reasoning { effort: "high" }),
        1 => (&models.complex, Reasoning { effort: "medium" }),
        _ => (&models.routine, Reasoning { effort: "low" }),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalClock {
    pub description: String,
    pub open: bool,
}

#[must_use]
pub fn local_clock(config: &AgentConfig, now: Timestamp) -> LocalClock {
    let zone = TimeZone::get(&config.timezone).unwrap_or(TimeZone::UTC);
    let zoned = now.to_zoned(zone);
    let weekday = u8::try_from(zoned.weekday().to_monday_one_offset()).unwrap_or(1);
    let hhmm = format!("{:02}:{:02}", zoned.hour(), zoned.minute());
    let open = config
        .business_hours
        .iter()
        .any(|entry| entry.iso_weekday == weekday && entry.opens.as_str() <= hhmm.as_str() && hhmm.as_str() < entry.closes.as_str());
    LocalClock { description: format!("{} {}", zoned.strftime("%Y-%m-%d %A %H:%M"), config.timezone), open }
}

#[must_use]
pub fn configured_language(config: &AgentConfig, locale: Locale) -> Option<&LanguageConfig> {
    config.languages.iter().find(|language| Locale::parse(&language.locale) == Some(locale))
}

#[must_use]
pub fn default_language(config: &AgentConfig) -> Option<&LanguageConfig> {
    config.languages.iter().find(|language| language.locale == config.default_locale).or_else(|| config.languages.first())
}

#[must_use]
pub fn language_config(config: &AgentConfig, locale: Locale) -> Option<&LanguageConfig> {
    configured_language(config, locale).or_else(|| default_language(config))
}

#[must_use]
pub fn default_locale(config: &AgentConfig) -> Locale {
    Locale::parse(&config.default_locale).unwrap_or(Locale::HU)
}

#[must_use]
pub fn configured_disclosure(config: &AgentConfig, locale: Locale) -> Option<&str> {
    config.disclosure.texts.iter().find(|(key, _)| Locale::parse(key) == Some(locale)).map(|(_, text)| text.as_str())
}

#[must_use]
pub fn disclosure_text(config: &AgentConfig, locale: Locale) -> Option<&str> {
    configured_disclosure(config, locale)
        .or_else(|| config.disclosure.texts.get(&config.default_locale).map(String::as_str))
        .or_else(|| config.disclosure.texts.values().next().map(String::as_str))
}

#[must_use]
pub const fn language_name(locale: Locale) -> &'static str {
    locale.english_name()
}

#[must_use]
pub const fn filler_text(locale: Locale) -> Option<&'static str> {
    locale.filler()
}

fn level(value: u8, low: &str, high: &str) -> String {
    match value {
        0..=33 => low.to_owned(),
        67..=100 => high.to_owned(),
        _ => format!("balanced between {low} and {high}"),
    }
}

pub struct PromptInputs<'a> {
    pub config: &'a AgentConfig,
    pub tools: &'a [ToolContract],
    pub locale: Locale,
    pub models: &'a ModelCatalog,
    pub max_output_tokens: u32,
    pub clock: &'a LocalClock,
}

#[must_use]
pub fn live_instructions(inputs: &PromptInputs<'_>) -> String {
    let config = inputs.config;
    let persona = &config.persona;
    let mut text = String::new();
    let name = language_name(inputs.locale);
    let _ = writeln!(
        text,
        "You are the voice of a phone assistant for this business. You speak every language fluently. Start in {name}. From the caller's first words on, always answer in the language the caller is speaking, and switch immediately and without comment whenever the caller switches language."
    );
    if let (Some(language), Some(disclosure)) = (configured_language(config, inputs.locale), configured_disclosure(config, inputs.locale)) {
        let _ = writeln!(text, "Your very first utterance must be exactly: \"{} {}\"", language.greeting, disclosure);
        let _ = writeln!(text, "When you cannot understand the caller say: \"{}\"", language.fallback);
        let _ = writeln!(text, "When the call ends say: \"{}\"", language.closing);
    } else if let Some(language) = default_language(config) {
        let disclosure = disclosure_text(config, inputs.locale).unwrap_or_default();
        let _ = writeln!(
            text,
            "Your very first utterance must be a faithful, natural {name} translation of: \"{} {}\". Keep every statement of it, including that you are an AI assistant.",
            language.greeting,
            disclosure
        );
        let _ = writeln!(text, "When you cannot understand the caller say, in the caller's language, the equivalent of: \"{}\"", language.fallback);
        let _ = writeln!(text, "When the call ends say, in the caller's language, the equivalent of: \"{}\"", language.closing);
    }
    let _ = writeln!(
        text,
        "Tone: {}; {}; {} energy; {} pace; {}; {}; {}; {}.",
        level(persona.warmth, "neutral", "warm"),
        level(persona.formality, "casual", "formal"),
        level(persona.energy, "calm", "lively"),
        level(persona.pace, "slow", "brisk"),
        level(persona.brevity, "detailed", "brief"),
        level(persona.empathy, "matter-of-fact", "empathetic"),
        level(persona.humor, "serious", "light-hearted"),
        level(persona.assertiveness, "gentle", "assertive"),
    );
    text.push_str("This is a phone call: keep every turn to one or two short sentences and never read out internal identifiers, JSON or tool names.\n");
    text.push_str("Delegate every business question, lookup, booking, change, cancellation, transfer and the end of the call to your backend. Never invent availability, prices, bookings, policies or results.\n");
    text.push_str("When the backend asks you to confirm an action, read the summary to the caller, ask for an explicit yes or no and pass the caller's exact answer back.\n");
    let _ = writeln!(
        text,
        "If you fail to understand the caller {} times in a row, offer a transfer to a human.",
        config.handoff.failed_understandings_before_offer
    );
    let _ = writeln!(
        text,
        "Local time: {}. The business is currently {}.",
        inputs.clock.description,
        if inputs.clock.open { "open" } else { "closed" }
    );
    if !inputs.clock.open {
        let behavior = match config.after_hours.behavior.as_str() {
            "CALLBACK_REQUEST" => "offer to arrange a callback during business hours",
            "TRANSFER_ON_CALL" => "offer a transfer to the on-call contact",
            _ => "offer to take a message",
        };
        let _ = writeln!(text, "Outside business hours {behavior}.");
    }
    let fallback = default_locale(config);
    for entry in config.pronunciation.iter().filter(|entry| Locale::parse(&entry.locale).is_some_and(|locale| locale == inputs.locale || locale == fallback)) {
        let _ = writeln!(text, "Pronounce \"{}\" as \"{}\".", entry.term, entry.spoken_as);
    }
    text
}

#[must_use]
pub fn backend_instructions(inputs: &PromptInputs<'_>) -> String {
    let config = inputs.config;
    let tools = gateway_tools(config, inputs.tools);
    let writes: Vec<&str> = tools.iter().filter(|tool| is_write(tool)).map(|tool| tool.name.as_str()).collect();
    let verified: Vec<&str> = tools.iter().filter(|tool| requires_verified_identity(tool)).map(|tool| tool.name.as_str()).collect();
    let mut text = String::new();
    let _ = writeln!(
        text,
        "You are the reasoning backend of a phone assistant. Your text is spoken to the caller, so answer with short, speakable sentences in the language the caller is speaking (currently {}). You understand and speak every language.",
        language_name(inputs.locale)
    );
    let _ = writeln!(
        text,
        "Business data, knowledge and names are stored in {}: write tool arguments and knowledge search queries in that language, and translate answers for the caller.",
        language_name(default_locale(config))
    );
    text.push_str("The runtime enforces these rules and rejects tool calls that break them:\n");
    let _ = writeln!(text, "1. Call {} as soon as the caller's goal is clear.", MetaTool::ReportIntent.name());
    text.push_str("2. Read-only tools may be used once the disclosure has been delivered.\n");
    if tools.iter().any(|tool| tool.name == KNOWLEDGE_SEARCH_TOOL) {
        let _ = writeln!(
            text,
            "   For questions about the practice (opening hours, prices, policies, directions, preparation) call {KNOWLEDGE_SEARCH_TOOL} first and answer only from the passages it returns."
        );
    }
    if !writes.is_empty() {
        let _ = writeln!(
            text,
            "3. Before a data-changing tool ({}) call {} with the exact tool name and arguments and a one-sentence summary, have the summary read to the caller, wait for the caller's answer, then call {}. Only after a confirmed answer call the tool with exactly the same arguments.",
            writes.join(", "),
            MetaTool::PrepareAction.name(),
            MetaTool::ConfirmAction.name()
        );
    }
    if !verified.is_empty() {
        let _ = writeln!(text, "4. These tools also require a verified caller identity: {}.", verified.join(", "));
    }
    if !config.handoff.destinations.is_empty() {
        let destinations: Vec<String> =
            config.handoff.destinations.iter().map(|destination| format!("{} ({})", destination.label, destination.description)).collect();
        let _ = writeln!(
            text,
            "5. Call {} when the caller asks for a human or you cannot help. Allowed destinations: {}.",
            MetaTool::RequestHandoff.name(),
            destinations.join(", ")
        );
    }
    let _ = writeln!(
        text,
        "6. Call {} with the ISO 639-1 code whenever the caller speaks or asks for a different language than the current one.",
        MetaTool::SetLanguage.name()
    );
    let _ = writeln!(text, "7. After finishing a request ask whether there is anything else and call {}.", MetaTool::NextStep.name());
    let _ = writeln!(text, "8. Call {} with the outcome once the conversation is complete.", MetaTool::EndCall.name());
    text.push_str("Never invent tool results. When a tool fails, apologise briefly and offer an alternative or a human.\n");
    let _ = writeln!(text, "Local time: {}.", inputs.clock.description);
    text
}

fn meta_parameters(tool: MetaTool, config: &AgentConfig, write_tools: &[&str]) -> Value {
    match tool {
        MetaTool::ReportIntent => json!({
            "type": "object",
            "properties": {
                "intent": { "type": "string", "enum": INTENTS },
                "summary": { "type": "string", "maxLength": 200 },
                "requires_identity": { "type": "boolean" }
            },
            "required": ["intent", "summary", "requires_identity"],
            "additionalProperties": false
        }),
        MetaTool::PrepareAction => json!({
            "type": "object",
            "properties": {
                "tool_name": { "type": "string", "enum": write_tools },
                "arguments": { "type": "object" },
                "summary": { "type": "string", "maxLength": 300 }
            },
            "required": ["tool_name", "arguments", "summary"],
            "additionalProperties": false
        }),
        MetaTool::ConfirmAction => json!({
            "type": "object",
            "properties": { "confirmed": { "type": "boolean" } },
            "required": ["confirmed"],
            "additionalProperties": false
        }),
        MetaTool::RequestHandoff => {
            let labels: Vec<&str> = config.handoff.destinations.iter().map(|destination| destination.label.as_str()).collect();
            json!({
                "type": "object",
                "properties": {
                    "destination_label": { "type": "string", "enum": labels },
                    "reason": { "type": "string", "maxLength": 200 }
                },
                "required": ["destination_label", "reason"],
                "additionalProperties": false
            })
        }
        MetaTool::SetLanguage => json!({
            "type": "object",
            "properties": { "locale": { "type": "string", "pattern": "^[a-z]{2,3}$" } },
            "required": ["locale"],
            "additionalProperties": false
        }),
        MetaTool::NextStep => json!({
            "type": "object",
            "properties": { "further_request": { "type": "boolean" } },
            "required": ["further_request"],
            "additionalProperties": false
        }),
        MetaTool::EndCall => json!({
            "type": "object",
            "properties": {
                "outcome": { "type": "string", "enum": END_OUTCOMES },
                "reason": { "type": "string", "maxLength": 200 }
            },
            "required": ["outcome", "reason"],
            "additionalProperties": false
        }),
    }
}

#[must_use]
pub fn function_tools(config: &AgentConfig, tools: &[ToolContract]) -> Vec<FunctionTool> {
    let gateway = gateway_tools(config, tools);
    let writes: Vec<&str> = gateway.iter().filter(|tool| is_write(tool)).map(|tool| tool.name.as_str()).collect();
    let mut result: Vec<FunctionTool> = gateway
        .iter()
        .map(|tool| FunctionTool { kind: "function", name: tool.name.clone(), description: tool.description.clone(), parameters: tool.input_schema.clone() })
        .collect();
    for meta in MetaTool::ALL {
        let skip = match meta {
            MetaTool::PrepareAction | MetaTool::ConfirmAction => writes.is_empty(),
            MetaTool::RequestHandoff => config.handoff.destinations.is_empty(),
            _ => false,
        };
        if !skip {
            result.push(FunctionTool {
                kind: "function",
                name: meta.name().to_owned(),
                description: meta.description().to_owned(),
                parameters: meta_parameters(meta, config, &writes),
            });
        }
    }
    result
}

#[must_use]
pub fn accept_request(inputs: &PromptInputs<'_>) -> AcceptRequest {
    let (model, reasoning) = backend_model(inputs.config, inputs.models);
    AcceptRequest {
        session: AcceptSession {
            kind: "live",
            model: inputs.models.live.clone(),
            instructions: live_instructions(inputs),
            audio: AudioConfig { output: AudioOutput { voice: inputs.config.voice.clone() } },
            delegation: Delegation::Responses {
                responses: ResponsesDelegation {
                    model: model.to_owned(),
                    instructions: backend_instructions(inputs),
                    max_output_tokens: inputs.max_output_tokens,
                    parallel_tool_calls: false,
                    reasoning: Some(reasoning),
                    tool_choice: "auto",
                    tools: function_tools(inputs.config, inputs.tools),
                },
            },
            store: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{agent_config_json, tools};

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    fn models() -> ModelCatalog {
        ModelCatalog {
            live: "gpt-live-1".into(),
            routine: "gpt-5.6-luna".into(),
            complex: "gpt-5.6-terra".into(),
            escalation: "gpt-5.6-sol".into(),
            frontier: "gpt-6-astra".into(),
        }
    }

    #[test]
    fn callers_in_any_language_get_a_faithful_translation_of_the_greeting() -> TestResult {
        let config: AgentConfig = serde_json::from_value(agent_config_json())?;
        let tools = tools();
        let models = models();
        let clock = local_clock(&config, "2026-09-14T10:00:00Z".parse()?);
        let chinese = Locale::parse("zh").ok_or("zh is a known language")?;
        let inputs = PromptInputs { config: &config, tools: &tools, locale: chinese, models: &models, max_output_tokens: 1024, clock: &clock };
        let live = live_instructions(&inputs);
        assert!(live.contains("Start in Chinese (Mandarin)."));
        assert!(live.contains("always answer in the language the caller is speaking"));
        assert!(live.contains("faithful, natural Chinese (Mandarin) translation of: \"Jó napot, a Demo Rendelő asszisztense vagyok."));
        assert!(!live.contains("must be exactly"));
        let backend = backend_instructions(&inputs);
        assert!(backend.contains("stored in Hungarian"));
        let set_language = function_tools(&config, &tools).into_iter().find(|tool| tool.name == "call_set_language").ok_or("call_set_language is always offered")?;
        assert_eq!(set_language.parameters.pointer("/properties/locale/pattern"), Some(&json!("^[a-z]{2,3}$")));
        Ok(())
    }

    #[test]
    fn builds_a_sip_accept_request_with_disclosure_first_and_gated_tools() -> TestResult {
        let config: AgentConfig = serde_json::from_value(agent_config_json())?;
        let tools = tools();
        let models = models();
        let clock = local_clock(&config, "2026-09-14T10:00:00Z".parse()?);
        let inputs = PromptInputs { config: &config, tools: &tools, locale: Locale::HU, models: &models, max_output_tokens: 1024, clock: &clock };
        let request = serde_json::to_value(accept_request(&inputs))?;
        assert_eq!(request.pointer("/session/type"), Some(&json!("live")));
        assert_eq!(request.pointer("/session/model"), Some(&json!("gpt-live-1")));
        assert_eq!(request.pointer("/session/audio/output/voice"), Some(&json!("marin")));
        assert_eq!(request.pointer("/session/store"), Some(&json!(false)));
        assert_eq!(request.pointer("/session/delegation/type"), Some(&json!("responses")));
        assert_eq!(request.pointer("/session/delegation/responses/model"), Some(&json!("gpt-5.6-luna")));
        assert_eq!(request.pointer("/session/delegation/responses/parallel_tool_calls"), Some(&json!(false)));
        let instructions = request.pointer("/session/instructions").and_then(Value::as_str).ok_or("instructions")?;
        assert!(instructions.contains(
            "\"Jó napot, a Demo Rendelő asszisztense vagyok. Mesterséges intelligencia alapú asszisztens vagyok, a hívás minőségbiztosítási célból feldolgozásra kerül.\""
        ));
        assert!(instructions.contains("Pronounce \"Velyric\" as \"Velirik\"."));
        assert!(instructions.contains("currently open"));
        let backend = request.pointer("/session/delegation/responses/instructions").and_then(Value::as_str).ok_or("backend instructions")?;
        assert!(backend.contains("call search_knowledge first and answer only from the passages"));
        let names: Vec<&str> = request
            .pointer("/session/delegation/responses/tools")
            .and_then(Value::as_array)
            .ok_or("tools")?
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect();
        assert_eq!(
            names,
            vec![
                "lookup_availability",
                "create_booking",
                "search_knowledge",
                "call_report_intent",
                "call_prepare_action",
                "call_confirm_action",
                "call_request_handoff",
                "call_set_language",
                "call_next_step",
                "call_end"
            ]
        );
        Ok(())
    }

    #[test]
    fn model_tiers_require_the_matching_routing_flags() -> TestResult {
        let mut config: AgentConfig = serde_json::from_value(agent_config_json())?;
        let models = models();
        if let Some(booking) = config.specialists.get_mut(1) {
            booking.model_tier = "FRONTIER".into();
        }
        assert_eq!(backend_model(&config, &models).0, "gpt-5.6-luna");
        config.model_routing.complex_escalation_enabled = true;
        assert_eq!(backend_model(&config, &models), ("gpt-5.6-terra", Reasoning { effort: "medium" }));
        config.model_routing.premium_reasoning_enabled = true;
        assert_eq!(backend_model(&config, &models), ("gpt-6-astra", Reasoning { effort: "high" }));
        if let Some(booking) = config.specialists.get_mut(1) {
            booking.enabled = false;
            booking.model_tier = "FRONTIER".into();
        }
        assert_eq!(backend_model(&config, &models).0, "gpt-5.6-luna");
        Ok(())
    }

    #[test]
    fn business_hours_follow_the_tenant_timezone() -> TestResult {
        let config: AgentConfig = serde_json::from_value(agent_config_json())?;
        let monday_noon = local_clock(&config, "2026-09-14T10:00:00Z".parse()?);
        assert!(monday_noon.open);
        assert_eq!(monday_noon.description, "2026-09-14 Monday 12:00 Europe/Budapest");
        assert!(!local_clock(&config, "2026-09-14T16:30:00Z".parse()?).open);
        assert!(!local_clock(&config, "2026-09-18T14:30:00Z".parse()?).open);
        assert!(local_clock(&config, "2026-09-18T13:30:00Z".parse()?).open);
        assert!(!local_clock(&config, "2026-09-19T10:00:00Z".parse()?).open);
        Ok(())
    }

    #[test]
    fn inactive_unlisted_or_reserved_tools_are_never_exposed() -> TestResult {
        let config: AgentConfig = serde_json::from_value(agent_config_json())?;
        let mut tools = tools();
        if let Some(first) = tools.first_mut() {
            first.active = false;
        }
        let mut shadow = tools.get(1).cloned().ok_or("tool")?;
        shadow.name = "call_end".into();
        tools.push(shadow);
        let mut foreign = tools.get(1).cloned().ok_or("tool")?;
        foreign.name = "delete_everything".into();
        tools.push(foreign);
        let exposed: Vec<&str> = gateway_tools(&config, &tools).iter().map(|tool| tool.name.as_str()).collect();
        assert_eq!(exposed, vec!["create_booking", "search_knowledge"]);
        assert_eq!(MetaTool::from_name("call_confirm_action"), Some(MetaTool::ConfirmAction));
        assert_eq!(MetaTool::from_name("create_booking"), None);
        Ok(())
    }
}
