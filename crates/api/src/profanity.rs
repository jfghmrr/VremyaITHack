//! Маскирование мата в тексте своего трека, который правит владелец. Те же правила, что у
//! GPU-обработчика (`gpu-worker/perepev_worker/profanity.py`): корни привязаны к началу
//! слова, поэтому «тихую», «застрахуй» или «мандарин» остаются чистыми. Первая буква
//! слова сохраняется, остальные заменяются звёздочками.
use regex::Regex;
use std::sync::LazyLock;

const PREFIXES: [&str; 23] = [
    "за", "на", "по", "под", "пере", "при", "про", "раз", "рас", "вы", "от", "до", "об", "у", "въ", "съ", "разъ", "подъ", "объ", "отъ",
    "изъ", "не", "ни",
];

static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\w+").expect("word pattern"));

static OBSCENE: LazyLock<Regex> = LazyLock::new(|| {
    let prefix = format!("(?:{})?", PREFIXES.join("|"));
    // Корень «ху» принимает те же приставки и ещё о-, а-, в- (охуеть, ахуеть, вхуярил).
    let hu_prefix = format!("(?:{}|о|а|в)?", PREFIXES.join("|"));
    let patterns = [
        format!(r"\b{hu_prefix}ху[йяеёию]\w*"),
        r"\w*пизд\w*".into(),
        format!(r"\b{prefix}[её]б(?:а[тлнй]|у(?:[тнчщ]|$)|л[аиоя]|[иёе]|ыр|ну|ош|ок)\w*"),
        r"\w*бляд\w*".into(),
        r"\bблят\w*".into(),
        r"\bбля\b".into(),
        r"\w*муд(?:ак|ач|ил|оз|охал)\w*".into(),
        r"\bманд(?:а|ы|е|у|ой|ою)\b".into(),
        r"\w*залуп\w*".into(),
        r"\w*гандон\w*".into(),
        r"\w*fuck\w*".into(),
        r"\bcunt\w*".into(),
        r"\bbitch\w*".into(),
        r"\basshole\w*".into(),
        r"\bwhore\w*".into(),
        r"\bslut\w*".into(),
        r"\bnigg(?:a|er)\w*".into(),
    ];
    Regex::new(&format!("(?i){}", patterns.join("|"))).expect("profanity patterns")
});

/// `\b(?:bull)?shit(?!ake)` из правил обработчика: в `regex` нет просмотра вперёд.
fn shit(word: &str) -> bool {
    let lower = word.to_lowercase();
    ["bullshit", "shit"].iter().any(|p| lower.strip_prefix(p).is_some_and(|rest| !rest.starts_with("ake")))
}

/// Символы форматирования (Unicode Cf): мягкий перенос, нулевой ширины, управление
/// направлением, теги. В тексте песни им не место, а слово с ними обходит маскирование.
pub fn strip_format(text: &str) -> String {
    text.chars()
        .filter(|c| {
            !matches!(c, '\u{00AD}' | '\u{061C}' | '\u{180E}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{206F}' | '\u{FEFF}' | '\u{FFF9}'..='\u{FFFB}'
                | '\u{E0001}' | '\u{E0020}'..='\u{E007F}')
        })
        .collect()
}

/// Латинская буква, похожая на кириллическую («xуй» с латинской x).
fn cyrillic_lookalike(c: char) -> char {
    match c {
        'a' | 'A' => 'а',
        'B' => 'в',
        'c' | 'C' => 'с',
        'e' | 'E' => 'е',
        'H' => 'н',
        'k' | 'K' => 'к',
        'm' | 'M' => 'м',
        'o' | 'O' => 'о',
        'p' | 'P' => 'р',
        't' | 'T' => 'т',
        'x' | 'X' => 'х',
        'y' | 'Y' => 'у',
        _ => c,
    }
}

fn obscene(word: &str) -> bool {
    if OBSCENE.is_match(word) || shit(word) {
        return true;
    }
    // Только слова, где кириллица смешана с латиницей: английские слова так не проверяются.
    let mixed = word.chars().any(|c| matches!(c, 'а'..='я' | 'А'..='Я' | 'ё' | 'Ё')) && word.chars().any(|c| c.is_ascii_alphabetic());
    mixed && OBSCENE.is_match(&word.chars().map(cyrillic_lookalike).collect::<String>())
}

/// Текст с замаскированными словами и их число.
pub fn mask(text: &str) -> (String, usize) {
    let mut count = 0;
    let masked = WORD.replace_all(text, |c: &regex::Captures| {
        let word = &c[0];
        if !obscene(word) {
            return word.to_owned();
        }
        count += 1;
        let mut chars = word.chars();
        let first = chars.next().map(String::from).unwrap_or_default();
        first + &"*".repeat(chars.count())
    });
    (masked.into_owned(), count)
}

#[cfg(test)]
mod tests {
    use super::mask;

    // Те же примеры, что в gpu-worker/tests/test_profanity.py.
    #[test]
    fn masks_roots() {
        for text in [
            "ну нахуй это", "Пиздец какой", "заебал уже", "Блядь!", "what the fuck", "Bullshit, man", "ну ебу", "охуеть можно", "мне похуй",
            "хуйня какая", "нехуй тут делать", "живём нехуёво", "выхуярил всё", "вхуярил гвоздь",
        ] {
            let (masked, count) = mask(text);
            assert_eq!(count, 1, "{text}");
            assert!(masked.contains('*'), "{text}");
            assert_eq!(masked.chars().count(), text.chars().count(), "{text}");
        }
    }

    #[test]
    fn keeps_first_letter_and_punctuation() {
        assert_eq!(mask("Блядь!"), ("Б****!".to_owned(), 1));
        assert_eq!(mask("fucking great"), ("f****** great".to_owned(), 1));
        assert_eq!(mask("хуй и пизда").1, 2);
    }

    #[test]
    fn lookalike_latin_letters_are_caught_in_mixed_words() {
        assert_eq!(mask("xуй"), ("x**".to_owned(), 1));
        assert_eq!(mask("eбaть"), ("e****".to_owned(), 1));
        assert_eq!(mask("ХУЙНЯ и XУЙНЕЙ").1, 2);
        for clean in ["Cтол и стул", "Mама", "Yes, sir", "Mama mia", "Hey, xyz", "Coca-Cola"] {
            assert_eq!(mask(clean).1, 0, "{clean}");
        }
    }

    #[test]
    fn format_characters_are_stripped() {
        assert_eq!(super::strip_format("х\u{200B}у\u{200D}й\u{202E}"), "хуй");
        assert_eq!(super::strip_format("сло\u{00AD}во\u{FEFF}"), "слово");
        assert_eq!(super::strip_format("обычный текст"), "обычный текст");
    }

    #[test]
    fn leaves_clean_words() {
        for text in [
            "Небо над землёю", "себе и тебе, себя", "ребёнок колеблется", "застрахуй машину", "кусок хлеба", "употребляя слова", "мандарин",
            "худо без друга", "оскорблять нельзя", "истреблять и углублять", "тихую ночь", "плохую погоду", "сухую траву", "глухую стену",
            "лихую тройку", "он психует", "не психуй", "хуже некуда", "похудеть", "хулиган", "нехудой кот", "выхухоль", "ухудшить",
            "прохудилась", "Shitake mushrooms? no, shiitake", "Scunthorpe", "assumption", "cocktail",
        ] {
            assert_eq!(mask(text), (text.to_owned(), 0), "{text}");
        }
    }
}
