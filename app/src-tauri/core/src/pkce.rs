//! PKCE (RFC 7636) and the OAuth `state` parameter.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};

/// 32 random bytes encode to 43 base64url characters, the RFC minimum.
const VERIFIER_BYTES: usize = 32;
const STATE_BYTES: usize = 32;

fn random_bytes<const N: usize>() -> Result<[u8; N], getrandom::Error> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes)?;
    Ok(bytes)
}

/// A fresh `code_verifier` from the operating system CSPRNG (43 chars, `[A-Za-z0-9_-]`).
pub fn new_verifier() -> Result<String, getrandom::Error> {
    Ok(verifier_from_bytes(&random_bytes::<VERIFIER_BYTES>()?))
}

pub fn verifier_from_bytes(bytes: &[u8; VERIFIER_BYTES]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `BASE64URL(SHA256(verifier))`, the `S256` code challenge.
pub fn challenge_s256(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// An unguessable `state` value from the operating system CSPRNG.
pub fn new_state() -> Result<String, getrandom::Error> {
    Ok(URL_SAFE_NO_PAD.encode(random_bytes::<STATE_BYTES>()?))
}

/// Constant-time equality for secrets of known length (`state`). A length
/// difference returns early: the length of `state` is not a secret.
pub fn ct_eq(left: &str, right: &str) -> bool {
    let (left, right) = (left.as_bytes(), right.as_bytes());
    if left.len() != right.len() {
        return false;
    }
    left.iter().zip(right).fold(0u8, |diff, (a, b)| diff | (a ^ b)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_unreserved(text: &str) -> bool {
        text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }

    #[test]
    fn challenge_matches_the_rfc_7636_appendix_b_vector() {
        assert_eq!(
            challenge_s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn rfc_octets_encode_to_the_rfc_verifier() {
        let octets = [
            116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37,
            77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
        ];
        assert_eq!(verifier_from_bytes(&octets), "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    }

    #[test]
    fn verifiers_are_long_unreserved_and_not_repeated() {
        let first = new_verifier().unwrap();
        let second = new_verifier().unwrap();
        for verifier in [&first, &second] {
            assert!((43..=128).contains(&verifier.len()), "{}", verifier.len());
            assert!(is_unreserved(verifier));
        }
        assert_ne!(first, second);
    }

    #[test]
    fn states_are_unreserved_and_not_repeated() {
        let (first, second) = (new_state().unwrap(), new_state().unwrap());
        assert!(first.len() >= 32 && is_unreserved(&first));
        assert_ne!(first, second);
    }

    #[test]
    fn ct_eq_accepts_only_identical_strings() {
        assert!(ct_eq("abc", "abc"));
        assert!(!ct_eq("abc", "abd"));
        assert!(!ct_eq("abc", "abcd"));
        assert!(!ct_eq("", "a"));
        assert!(ct_eq("", ""));
    }
}
