use serde::{Deserialize, Deserializer, Serialize, Serializer};

struct LanguageInfo {
    code: &'static str,
    name: &'static str,
    aliases: &'static [&'static str],
    filler: Option<&'static str>,
}

const LANGUAGES: &[LanguageInfo] = &[
    LanguageInfo { code: "hu", name: "Hungarian", aliases: &["hun", "hungarian", "magyar"], filler: Some("Egy pillanat türelmet kérek, utánanézek.") },
    LanguageInfo { code: "de", name: "German", aliases: &["deu", "ger", "german", "deutsch"], filler: Some("Einen Moment bitte, ich sehe kurz nach.") },
    LanguageInfo { code: "en", name: "English", aliases: &["eng", "english"], filler: Some("One moment please, let me check that.") },
    LanguageInfo { code: "fr", name: "French", aliases: &["fra", "fre", "french", "français", "francais"], filler: Some("Un instant, s'il vous plaît, je vérifie.") },
    LanguageInfo { code: "es", name: "Spanish", aliases: &["spa", "spanish", "español", "espanol"], filler: Some("Un momento, por favor, lo compruebo.") },
    LanguageInfo { code: "it", name: "Italian", aliases: &["ita", "italian", "italiano"], filler: Some("Un attimo, per favore, controllo subito.") },
    LanguageInfo { code: "pt", name: "Portuguese", aliases: &["por", "portuguese", "português", "portugues"], filler: Some("Um momento, por favor, vou verificar.") },
    LanguageInfo { code: "nl", name: "Dutch", aliases: &["nld", "dut", "dutch", "nederlands"], filler: Some("Een ogenblik alstublieft, ik kijk het even na.") },
    LanguageInfo { code: "pl", name: "Polish", aliases: &["pol", "polish", "polski"], filler: Some("Chwileczkę, proszę, już sprawdzam.") },
    LanguageInfo { code: "cs", name: "Czech", aliases: &["ces", "cze", "czech", "čeština", "cestina"], filler: Some("Moment, prosím, hned to ověřím.") },
    LanguageInfo { code: "sk", name: "Slovak", aliases: &["slk", "slo", "slovak", "slovenčina", "slovencina"], filler: Some("Moment, prosím, hneď to overím.") },
    LanguageInfo { code: "ro", name: "Romanian", aliases: &["ron", "rum", "romanian", "română", "romana"], filler: Some("Un moment, vă rog, verific imediat.") },
    LanguageInfo { code: "hr", name: "Croatian", aliases: &["hrv", "croatian", "hrvatski"], filler: Some("Trenutak, molim, odmah provjeravam.") },
    LanguageInfo { code: "sr", name: "Serbian", aliases: &["srp", "serbian", "srpski"], filler: Some("Trenutak, molim, odmah proveravam.") },
    LanguageInfo { code: "bs", name: "Bosnian", aliases: &["bos", "bosnian", "bosanski"], filler: Some("Trenutak, molim, odmah provjeravam.") },
    LanguageInfo { code: "sl", name: "Slovenian", aliases: &["slv", "slovenian", "slovene", "slovenščina"], filler: Some("Trenutek, prosim, takoj preverim.") },
    LanguageInfo { code: "bg", name: "Bulgarian", aliases: &["bul", "bulgarian"], filler: Some("Един момент, моля, веднага ще проверя.") },
    LanguageInfo { code: "mk", name: "Macedonian", aliases: &["mkd", "mac", "macedonian"], filler: Some("Момент, ве молам, веднаш ќе проверам.") },
    LanguageInfo { code: "sq", name: "Albanian", aliases: &["sqi", "alb", "albanian", "shqip"], filler: Some("Një moment, ju lutem, po e kontrolloj.") },
    LanguageInfo { code: "uk", name: "Ukrainian", aliases: &["ukr", "ukrainian"], filler: Some("Хвилинку, будь ласка, зараз перевірю.") },
    LanguageInfo { code: "ru", name: "Russian", aliases: &["rus", "russian"], filler: Some("Одну минуту, пожалуйста, сейчас проверю.") },
    LanguageInfo { code: "be", name: "Belarusian", aliases: &["bel", "belarusian"], filler: None },
    LanguageInfo { code: "el", name: "Greek", aliases: &["ell", "gre", "greek"], filler: Some("Μια στιγμή, παρακαλώ, το ελέγχω.") },
    LanguageInfo { code: "tr", name: "Turkish", aliases: &["tur", "turkish", "türkçe", "turkce"], filler: Some("Bir dakika lütfen, hemen kontrol ediyorum.") },
    LanguageInfo { code: "sv", name: "Swedish", aliases: &["swe", "swedish", "svenska"], filler: Some("Ett ögonblick, jag kollar det.") },
    LanguageInfo { code: "da", name: "Danish", aliases: &["dan", "danish", "dansk"], filler: Some("Et øjeblik, jeg tjekker det lige.") },
    LanguageInfo { code: "nb", name: "Norwegian", aliases: &["no", "nob", "nor", "nn", "norwegian", "norsk"], filler: Some("Et øyeblikk, jeg sjekker det.") },
    LanguageInfo { code: "fi", name: "Finnish", aliases: &["fin", "finnish", "suomi"], filler: Some("Hetkinen, tarkistan asian.") },
    LanguageInfo { code: "is", name: "Icelandic", aliases: &["isl", "ice", "icelandic"], filler: Some("Augnablik, ég athuga það.") },
    LanguageInfo { code: "et", name: "Estonian", aliases: &["est", "estonian", "eesti"], filler: Some("Üks hetk, palun, ma kontrollin.") },
    LanguageInfo { code: "lv", name: "Latvian", aliases: &["lav", "latvian"], filler: Some("Mirklīti, lūdzu, es pārbaudīšu.") },
    LanguageInfo { code: "lt", name: "Lithuanian", aliases: &["lit", "lithuanian"], filler: Some("Akimirką, prašau, tuoj patikrinsiu.") },
    LanguageInfo { code: "ca", name: "Catalan", aliases: &["cat", "catalan", "català"], filler: Some("Un moment, si us plau, ho comprovo.") },
    LanguageInfo { code: "mt", name: "Maltese", aliases: &["mlt", "maltese"], filler: None },
    LanguageInfo { code: "ga", name: "Irish", aliases: &["gle", "irish"], filler: None },
    LanguageInfo { code: "lb", name: "Luxembourgish", aliases: &["ltz", "luxembourgish"], filler: None },
    LanguageInfo { code: "fo", name: "Faroese", aliases: &["fao", "faroese"], filler: None },
    LanguageInfo { code: "kl", name: "Greenlandic", aliases: &["kal", "greenlandic"], filler: None },
    LanguageInfo { code: "hy", name: "Armenian", aliases: &["hye", "arm", "armenian"], filler: Some("Մի պահ, խնդրում եմ, հիմա կստուգեմ։") },
    LanguageInfo { code: "ka", name: "Georgian", aliases: &["kat", "geo", "georgian"], filler: None },
    LanguageInfo { code: "az", name: "Azerbaijani", aliases: &["aze", "azerbaijani"], filler: Some("Bir dəqiqə, zəhmət olmasa, yoxlayıram.") },
    LanguageInfo { code: "kk", name: "Kazakh", aliases: &["kaz", "kazakh"], filler: None },
    LanguageInfo { code: "uz", name: "Uzbek", aliases: &["uzb", "uzbek"], filler: None },
    LanguageInfo { code: "ky", name: "Kyrgyz", aliases: &["kir", "kyrgyz"], filler: None },
    LanguageInfo { code: "tg", name: "Tajik", aliases: &["tgk", "tajik"], filler: None },
    LanguageInfo { code: "tk", name: "Turkmen", aliases: &["tuk", "turkmen"], filler: None },
    LanguageInfo { code: "mn", name: "Mongolian", aliases: &["mon", "mongolian"], filler: None },
    LanguageInfo { code: "zh", name: "Chinese (Mandarin)", aliases: &["zho", "chi", "cmn", "chinese", "mandarin", "中文"], filler: Some("请稍等，我帮您查一下。") },
    LanguageInfo { code: "yue", name: "Cantonese", aliases: &["cantonese", "粵語"], filler: None },
    LanguageInfo { code: "ja", name: "Japanese", aliases: &["jpn", "japanese", "日本語"], filler: Some("少々お待ちください。確認いたします。") },
    LanguageInfo { code: "ko", name: "Korean", aliases: &["kor", "korean", "한국어"], filler: Some("잠시만 기다려 주세요. 확인해 보겠습니다.") },
    LanguageInfo { code: "vi", name: "Vietnamese", aliases: &["vie", "vietnamese", "tiếng việt"], filler: Some("Xin vui lòng chờ một chút, tôi kiểm tra ngay.") },
    LanguageInfo { code: "th", name: "Thai", aliases: &["tha", "thai"], filler: Some("กรุณารอสักครู่ ขอตรวจสอบก่อน") },
    LanguageInfo { code: "lo", name: "Lao", aliases: &["lao"], filler: None },
    LanguageInfo { code: "km", name: "Khmer", aliases: &["khm", "khmer"], filler: None },
    LanguageInfo { code: "my", name: "Burmese", aliases: &["mya", "bur", "burmese"], filler: None },
    LanguageInfo { code: "id", name: "Indonesian", aliases: &["ind", "indonesian", "bahasa indonesia"], filler: Some("Mohon tunggu sebentar, saya cek dulu.") },
    LanguageInfo { code: "ms", name: "Malay", aliases: &["msa", "may", "malay", "bahasa melayu"], filler: Some("Sila tunggu sebentar, saya semak dahulu.") },
    LanguageInfo { code: "tl", name: "Filipino (Tagalog)", aliases: &["fil", "tgl", "filipino", "tagalog"], filler: Some("Sandali po, tinitingnan ko.") },
    LanguageInfo { code: "hi", name: "Hindi", aliases: &["hin", "hindi"], filler: Some("कृपया एक क्षण प्रतीक्षा करें।") },
    LanguageInfo { code: "ur", name: "Urdu", aliases: &["urd", "urdu"], filler: Some("براہ کرم ایک لمحہ انتظار کریں۔") },
    LanguageInfo { code: "bn", name: "Bengali", aliases: &["ben", "bengali", "bangla"], filler: Some("অনুগ্রহ করে একটু অপেক্ষা করুন, আমি দেখে নিচ্ছি।") },
    LanguageInfo { code: "ne", name: "Nepali", aliases: &["nep", "nepali"], filler: None },
    LanguageInfo { code: "si", name: "Sinhala", aliases: &["sin", "sinhala"], filler: None },
    LanguageInfo { code: "ta", name: "Tamil", aliases: &["tam", "tamil"], filler: None },
    LanguageInfo { code: "ar", name: "Arabic", aliases: &["ara", "arabic", "العربية"], filler: Some("لحظة من فضلك، سأتحقق من ذلك.") },
    LanguageInfo { code: "he", name: "Hebrew", aliases: &["heb", "iw", "hebrew", "עברית"], filler: Some("רגע אחד בבקשה, אני בודק את זה.") },
    LanguageInfo { code: "fa", name: "Persian", aliases: &["fas", "per", "persian", "farsi", "dari"], filler: Some("لطفاً یک لحظه صبر کنید، بررسی می‌کنم.") },
    LanguageInfo { code: "ps", name: "Pashto", aliases: &["pus", "pashto"], filler: None },
    LanguageInfo { code: "sw", name: "Swahili", aliases: &["swa", "swahili", "kiswahili"], filler: Some("Tafadhali subiri kidogo, ninaangalia.") },
    LanguageInfo { code: "am", name: "Amharic", aliases: &["amh", "amharic"], filler: None },
    LanguageInfo { code: "ti", name: "Tigrinya", aliases: &["tir", "tigrinya"], filler: None },
    LanguageInfo { code: "so", name: "Somali", aliases: &["som", "somali"], filler: None },
    LanguageInfo { code: "af", name: "Afrikaans", aliases: &["afr", "afrikaans"], filler: Some("Een oomblik asseblief, ek kyk gou.") },
    LanguageInfo { code: "zu", name: "Zulu", aliases: &["zul", "zulu"], filler: None },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Locale {
    index: u8,
}

impl Locale {
    pub const HU: Self = Self { index: 0 };
    pub const DE: Self = Self { index: 1 };
    pub const EN: Self = Self { index: 2 };

    const fn info(self) -> &'static LanguageInfo {
        &LANGUAGES[self.index as usize]
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        self.info().code
    }

    #[must_use]
    pub const fn english_name(self) -> &'static str {
        self.info().name
    }

    #[must_use]
    pub const fn filler(self) -> Option<&'static str> {
        self.info().filler
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        let lowered = value.trim().to_lowercase();
        if lowered.is_empty() {
            return None;
        }
        let primary = lowered.split(['-', '_']).next().unwrap_or_default();
        LANGUAGES
            .iter()
            .position(|language| language.code == lowered || language.code == primary || language.aliases.iter().any(|alias| *alias == lowered || *alias == primary))
            .and_then(|index| u8::try_from(index).ok())
            .map(|index| Self { index })
    }

    pub fn all() -> impl Iterator<Item = Self> {
        (0..LANGUAGES.len()).filter_map(|index| u8::try_from(index).ok()).map(|index| Self { index })
    }
}

impl Serialize for Locale {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Locale {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).ok_or_else(|| serde::de::Error::custom(format!("unknown language {value}")))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LanguageSource {
    ExplicitRequest,
    ConfirmedPreference,
    Detected,
    CallerCountryHint,
    TenantDefault,
}

const CALLING_CODES: &[(&str, &str)] = &[
    ("1787", "es"),
    ("1939", "es"),
    ("1809", "es"),
    ("1829", "es"),
    ("1849", "es"),
    ("1", "en"),
    ("7", "ru"),
    ("20", "ar"),
    ("211", "en"),
    ("212", "ar"),
    ("213", "ar"),
    ("216", "ar"),
    ("218", "ar"),
    ("220", "en"),
    ("221", "fr"),
    ("222", "ar"),
    ("223", "fr"),
    ("224", "fr"),
    ("225", "fr"),
    ("226", "fr"),
    ("227", "fr"),
    ("228", "fr"),
    ("229", "fr"),
    ("230", "en"),
    ("231", "en"),
    ("232", "en"),
    ("233", "en"),
    ("234", "en"),
    ("235", "fr"),
    ("236", "fr"),
    ("237", "fr"),
    ("238", "pt"),
    ("239", "pt"),
    ("240", "es"),
    ("241", "fr"),
    ("242", "fr"),
    ("243", "fr"),
    ("244", "pt"),
    ("245", "pt"),
    ("246", "en"),
    ("247", "en"),
    ("248", "en"),
    ("249", "ar"),
    ("250", "en"),
    ("251", "am"),
    ("252", "so"),
    ("253", "fr"),
    ("254", "sw"),
    ("255", "sw"),
    ("256", "en"),
    ("257", "fr"),
    ("258", "pt"),
    ("260", "en"),
    ("261", "fr"),
    ("262", "fr"),
    ("263", "en"),
    ("264", "en"),
    ("265", "en"),
    ("266", "en"),
    ("267", "en"),
    ("268", "en"),
    ("269", "fr"),
    ("27", "en"),
    ("290", "en"),
    ("291", "ti"),
    ("297", "nl"),
    ("298", "fo"),
    ("299", "kl"),
    ("30", "el"),
    ("31", "nl"),
    ("32", "nl"),
    ("33", "fr"),
    ("34", "es"),
    ("350", "en"),
    ("351", "pt"),
    ("352", "fr"),
    ("353", "en"),
    ("354", "is"),
    ("355", "sq"),
    ("356", "en"),
    ("357", "el"),
    ("358", "fi"),
    ("359", "bg"),
    ("36", "hu"),
    ("370", "lt"),
    ("371", "lv"),
    ("372", "et"),
    ("373", "ro"),
    ("374", "hy"),
    ("375", "ru"),
    ("376", "ca"),
    ("377", "fr"),
    ("378", "it"),
    ("379", "it"),
    ("380", "uk"),
    ("381", "sr"),
    ("382", "sr"),
    ("383", "sq"),
    ("385", "hr"),
    ("386", "sl"),
    ("387", "bs"),
    ("389", "mk"),
    ("39", "it"),
    ("40", "ro"),
    ("41", "de"),
    ("420", "cs"),
    ("421", "sk"),
    ("423", "de"),
    ("43", "de"),
    ("44", "en"),
    ("45", "da"),
    ("46", "sv"),
    ("47", "nb"),
    ("48", "pl"),
    ("49", "de"),
    ("500", "en"),
    ("501", "en"),
    ("502", "es"),
    ("503", "es"),
    ("504", "es"),
    ("505", "es"),
    ("506", "es"),
    ("507", "es"),
    ("508", "fr"),
    ("509", "fr"),
    ("51", "es"),
    ("52", "es"),
    ("53", "es"),
    ("54", "es"),
    ("55", "pt"),
    ("56", "es"),
    ("57", "es"),
    ("58", "es"),
    ("590", "fr"),
    ("591", "es"),
    ("592", "en"),
    ("593", "es"),
    ("594", "fr"),
    ("595", "es"),
    ("596", "fr"),
    ("597", "nl"),
    ("598", "es"),
    ("599", "nl"),
    ("60", "ms"),
    ("61", "en"),
    ("62", "id"),
    ("63", "en"),
    ("64", "en"),
    ("65", "en"),
    ("66", "th"),
    ("670", "pt"),
    ("672", "en"),
    ("673", "ms"),
    ("674", "en"),
    ("675", "en"),
    ("676", "en"),
    ("677", "en"),
    ("678", "en"),
    ("679", "en"),
    ("680", "en"),
    ("681", "fr"),
    ("682", "en"),
    ("683", "en"),
    ("685", "en"),
    ("686", "en"),
    ("687", "fr"),
    ("688", "en"),
    ("689", "fr"),
    ("690", "en"),
    ("691", "en"),
    ("692", "en"),
    ("81", "ja"),
    ("82", "ko"),
    ("84", "vi"),
    ("850", "ko"),
    ("852", "yue"),
    ("853", "yue"),
    ("855", "km"),
    ("856", "lo"),
    ("86", "zh"),
    ("880", "bn"),
    ("886", "zh"),
    ("90", "tr"),
    ("91", "en"),
    ("92", "ur"),
    ("93", "fa"),
    ("94", "si"),
    ("95", "my"),
    ("960", "en"),
    ("961", "ar"),
    ("962", "ar"),
    ("963", "ar"),
    ("964", "ar"),
    ("965", "ar"),
    ("966", "ar"),
    ("967", "ar"),
    ("968", "ar"),
    ("970", "ar"),
    ("971", "ar"),
    ("972", "he"),
    ("973", "ar"),
    ("974", "ar"),
    ("975", "en"),
    ("976", "mn"),
    ("977", "ne"),
    ("98", "fa"),
    ("992", "tg"),
    ("993", "tk"),
    ("994", "az"),
    ("995", "ka"),
    ("996", "ky"),
    ("998", "uz"),
];

#[must_use]
pub fn hint_from_e164(e164: &str) -> Option<Locale> {
    let digits = e164.strip_prefix('+')?;
    if !digits.chars().all(|digit| digit.is_ascii_digit()) || digits.len() < 7 {
        return None;
    }
    CALLING_CODES
        .iter()
        .filter(|(prefix, _)| digits.starts_with(prefix))
        .max_by_key(|(prefix, _)| prefix.len())
        .and_then(|(_, code)| Locale::parse(code))
}

#[derive(Debug, Clone, Copy)]
pub struct LanguageInputs<'a> {
    pub explicit_request: Option<Locale>,
    pub confirmed_preference: Option<Locale>,
    pub detected: Option<Locale>,
    pub caller_e164: Option<&'a str>,
    pub tenant_default: Locale,
}

#[must_use]
pub fn resolve_language(inputs: LanguageInputs<'_>) -> (Locale, LanguageSource) {
    let candidates = [
        (inputs.explicit_request, LanguageSource::ExplicitRequest),
        (inputs.confirmed_preference, LanguageSource::ConfirmedPreference),
        (inputs.detected, LanguageSource::Detected),
        (inputs.caller_e164.and_then(hint_from_e164), LanguageSource::CallerCountryHint),
    ];
    candidates
        .into_iter()
        .find_map(|(locale, source)| locale.map(|value| (value, source)))
        .unwrap_or((inputs.tenant_default, LanguageSource::TenantDefault))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs() -> LanguageInputs<'static> {
        LanguageInputs { explicit_request: None, confirmed_preference: None, detected: None, caller_e164: None, tenant_default: Locale::HU }
    }

    fn code(e164: &str) -> Option<&'static str> {
        hint_from_e164(e164).map(Locale::as_str)
    }

    #[test]
    fn every_calling_code_maps_to_a_known_language() {
        for (prefix, language) in CALLING_CODES {
            assert!(Locale::parse(language).is_some(), "+{prefix} maps to unknown language {language}");
        }
        let codes: std::collections::HashSet<&str> = LANGUAGES.iter().map(|language| language.code).collect();
        assert_eq!(codes.len(), LANGUAGES.len());
    }

    #[test]
    fn country_code_hints_cover_callers_from_everywhere() {
        assert_eq!(code("+4930123456"), Some("de"));
        assert_eq!(code("+36301234567"), Some("hu"));
        assert_eq!(code("+4234401234"), Some("de"));
        assert_eq!(code("+33123456789"), Some("fr"));
        assert_eq!(code("+8613812345678"), Some("zh"));
        assert_eq!(code("+81312345678"), Some("ja"));
        assert_eq!(code("+420601234567"), Some("cs"));
        assert_eq!(code("+421901234567"), Some("sk"));
        assert_eq!(code("+380501234567"), Some("uk"));
        assert_eq!(code("+971501234567"), Some("ar"));
        assert_eq!(code("+5511912345678"), Some("pt"));
        assert_eq!(code("+17875551234"), Some("es"));
        assert_eq!(code("+12125551234"), Some("en"));
        assert_eq!(code("36301234567"), None);
        assert_eq!(code("+36123"), None);
        assert_eq!(resolve_language(LanguageInputs { caller_e164: Some("+8613812345678"), ..inputs() }), (Locale::parse("zh").unwrap_or(Locale::EN), LanguageSource::CallerCountryHint));
    }

    #[test]
    fn explicit_request_beats_preference_detection_and_hint() {
        let french = Locale::parse("fr").unwrap_or(Locale::EN);
        let resolved = resolve_language(LanguageInputs {
            explicit_request: Some(french),
            confirmed_preference: Some(Locale::EN),
            detected: Some(Locale::DE),
            caller_e164: Some("+4930123456"),
            ..inputs()
        });
        assert_eq!(resolved, (french, LanguageSource::ExplicitRequest));
        assert_eq!(resolve_language(LanguageInputs { confirmed_preference: Some(Locale::EN), detected: Some(Locale::DE), ..inputs() }), (Locale::EN, LanguageSource::ConfirmedPreference));
        assert_eq!(resolve_language(LanguageInputs { detected: Some(Locale::DE), caller_e164: Some("+36301234567"), ..inputs() }), (Locale::DE, LanguageSource::Detected));
        assert_eq!(resolve_language(inputs()), (Locale::HU, LanguageSource::TenantDefault));
    }

    #[test]
    fn parses_codes_tags_and_names() {
        assert_eq!(Locale::parse("Magyar"), Some(Locale::HU));
        assert_eq!(Locale::parse("de-AT"), Some(Locale::DE));
        assert_eq!(Locale::parse("zh-Hans-CN").map(Locale::as_str), Some("zh"));
        assert_eq!(Locale::parse("pt_BR").map(Locale::as_str), Some("pt"));
        assert_eq!(Locale::parse("no").map(Locale::as_str), Some("nb"));
        assert_eq!(Locale::parse("klingon"), None);
        assert_eq!(Locale::HU.as_str(), "hu");
        assert_eq!(Locale::DE.english_name(), "German");
        assert_eq!(Locale::EN.as_str(), "en");
        assert_eq!(serde_json::to_string(&Locale::DE).ok().as_deref(), Some("\"de\""));
        assert_eq!(serde_json::from_str::<Locale>("\"ja\"").ok().map(Locale::as_str), Some("ja"));
    }
}
