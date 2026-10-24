use crate::{
	limits::{AVATAR_SIZES, MAX_AVATAR_LEN, NAME_MAX, NAME_MIN},
	validate::{is_utf8, validate_avatar, validate_name, validate_pgp, AvatarError, NameError},
};

const LOSSY: &[u8] = include_bytes!("../../tests/fixtures/avatar-64-lossy.webp");
const LOSSLESS: &[u8] = include_bytes!("../../tests/fixtures/avatar-64-lossless.webp");
const ALPHA: &[u8] = include_bytes!("../../tests/fixtures/avatar-64-alpha.webp");
const WIDE: &[u8] = include_bytes!("../../tests/fixtures/avatar-65x64.webp");
const PNG: &[u8] = include_bytes!("../../tests/fixtures/avatar-64.png");

/// Offsets inside the fixtures, derived from the WebP container layout.
mod at {
	/// Four-character code of the first chunk.
	pub const FIRST_CHUNK: usize = 12;
	/// Width field of the VP8 key-frame header (RIFF 12 + chunk header 8 + tag 3 + start code 3).
	pub const VP8_WIDTH: usize = 26;
	/// Signature of the VP8 key-frame header.
	pub const VP8_SIGNATURE: usize = 23;
	/// Signature byte of the VP8L header.
	pub const VP8L_SIGNATURE: usize = 20;
	/// Canvas width-1 field of VP8X (24 bits).
	pub const VP8X_WIDTH: usize = 24;
	/// Canvas height-1 field of VP8X (24 bits).
	pub const VP8X_HEIGHT: usize = 27;
}

fn padded(bytes: &[u8], len: usize) -> Vec<u8> {
	let mut out = bytes.to_vec();
	out.resize(len, 0);
	out
}

#[test]
fn fixtures_are_what_their_names_say() {
	assert_eq!(&LOSSY[at::FIRST_CHUNK..at::FIRST_CHUNK + 4], b"VP8 ");
	assert_eq!(&LOSSLESS[at::FIRST_CHUNK..at::FIRST_CHUNK + 4], b"VP8L");
	assert_eq!(&ALPHA[at::FIRST_CHUNK..at::FIRST_CHUNK + 4], b"VP8X");
	assert!(ALPHA.windows(4).any(|w| w == b"ALPH"));
	assert_eq!(&PNG[..4], b"\x89PNG");
	for webp in [LOSSY, LOSSLESS, ALPHA, WIDE] {
		assert!(webp.len() <= MAX_AVATAR_LEN as usize);
	}
	assert_eq!(AVATAR_SIZES, [(64, 64)]);
}

#[test]
fn avatar_accepts_vp8_64x64() {
	assert_eq!(validate_avatar(LOSSY), Ok(()));
}

#[test]
fn avatar_accepts_vp8l_64x64() {
	assert_eq!(validate_avatar(LOSSLESS), Ok(()));
}

#[test]
fn avatar_accepts_vp8x_64x64() {
	assert_eq!(validate_avatar(ALPHA), Ok(()));
}

#[test]
fn avatar_rejects_65x64() {
	assert_eq!(validate_avatar(WIDE), Err(AvatarError::BadDimensions));
}

#[test]
fn avatar_rejects_wrong_dimensions_in_every_container() {
	// Patch the width field of each fixture to 65 (stored as 65 for VP8, 64 for the "-1" forms).
	let mut vp8 = LOSSY.to_vec();
	vp8[at::VP8_WIDTH] = 65;
	assert_eq!(validate_avatar(&vp8), Err(AvatarError::BadDimensions));

	// VP8L packs width-1 in the low 14 bits of the 32 bits that follow the signature.
	let mut vp8l = LOSSLESS.to_vec();
	vp8l[at::VP8L_SIGNATURE + 1] = 64;
	assert_eq!(validate_avatar(&vp8l), Err(AvatarError::BadDimensions));

	let mut vp8x_w = ALPHA.to_vec();
	vp8x_w[at::VP8X_WIDTH] = 64;
	assert_eq!(validate_avatar(&vp8x_w), Err(AvatarError::BadDimensions));
	let mut vp8x_h = ALPHA.to_vec();
	vp8x_h[at::VP8X_HEIGHT] = 0;
	assert_eq!(validate_avatar(&vp8x_h), Err(AvatarError::BadDimensions));
}

#[test]
fn avatar_vp8_dimensions_ignore_the_two_scaling_bits() {
	// The top two bits of each 16-bit VP8 dimension are a scaling hint, not part of the size.
	let mut scaled = LOSSY.to_vec();
	scaled[at::VP8_WIDTH + 1] |= 0b1100_0000;
	assert_eq!(validate_avatar(&scaled), Ok(()));
}

#[test]
fn avatar_rejects_png() {
	assert_eq!(validate_avatar(PNG), Err(AvatarError::NotWebp));
}

#[test]
fn avatar_rejects_riff_that_is_not_webp() {
	let mut wave = LOSSY.to_vec();
	wave[8..12].copy_from_slice(b"WAVE");
	assert_eq!(validate_avatar(&wave), Err(AvatarError::NotWebp));
}

#[test]
fn avatar_rejects_wrong_bitstream_signatures() {
	let mut vp8 = LOSSY.to_vec();
	vp8[at::VP8_SIGNATURE] = 0;
	assert_eq!(validate_avatar(&vp8), Err(AvatarError::NotWebp));
	let mut vp8l = LOSSLESS.to_vec();
	vp8l[at::VP8L_SIGNATURE] = 0;
	assert_eq!(validate_avatar(&vp8l), Err(AvatarError::NotWebp));
}

#[test]
fn avatar_rejects_unsupported_first_chunk() {
	for code in [b"ANIM", b"ALPH", b"EXIF", b"ICCP", b"JUNK"] {
		let mut other = LOSSY.to_vec();
		other[at::FIRST_CHUNK..at::FIRST_CHUNK + 4].copy_from_slice(code);
		assert_eq!(validate_avatar(&other), Err(AvatarError::UnsupportedChunk), "{code:?}");
	}
}

#[test]
fn avatar_rejects_over_8192_bytes() {
	assert_eq!(MAX_AVATAR_LEN, 8192);
	// Trailing bytes after the RIFF payload are ignored, so exactly the limit is fine...
	assert_eq!(validate_avatar(&padded(LOSSY, 8192)), Ok(()));
	// ...and one more byte is not, whatever the header says.
	assert_eq!(validate_avatar(&padded(LOSSY, 8193)), Err(AvatarError::TooLarge));
	assert_eq!(validate_avatar(&padded(PNG, 8193)), Err(AvatarError::TooLarge));
}

#[test]
fn avatar_rejects_truncated_header() {
	assert_eq!(validate_avatar(&LOSSY[..20]), Err(AvatarError::Truncated));
	assert_eq!(validate_avatar(&LOSSLESS[..20]), Err(AvatarError::Truncated));
	assert_eq!(validate_avatar(&ALPHA[..20]), Err(AvatarError::Truncated));
}

#[test]
fn avatar_rejects_every_proper_prefix_of_a_valid_file() {
	for file in [LOSSY, LOSSLESS, ALPHA] {
		for len in 0..file.len() {
			assert_eq!(
				validate_avatar(&file[..len]),
				Err(AvatarError::Truncated),
				"prefix of {len} bytes"
			);
		}
	}
}

#[test]
fn avatar_short_non_webp_input_is_not_webp_or_truncated() {
	assert_eq!(validate_avatar(&[]), Err(AvatarError::Truncated));
	assert_eq!(validate_avatar(b"RIF"), Err(AvatarError::Truncated));
	// A prefix that already contradicts the magic is not a webp, however short.
	assert_eq!(validate_avatar(b"\x89PNG"), Err(AvatarError::NotWebp));
	assert_eq!(validate_avatar(b"RIFF\0\0\0\0WA"), Err(AvatarError::NotWebp));
}

#[test]
fn avatar_does_not_trust_the_riff_size_field() {
	for size in [u32::MAX, u32::MAX - 7, 0x1_0000, LOSSY.len() as u32] {
		let mut lying = LOSSY.to_vec();
		lying[4..8].copy_from_slice(&size.to_le_bytes());
		assert_eq!(validate_avatar(&lying), Err(AvatarError::Truncated), "riff size {size}");
	}
	// A first chunk that claims to run past the end of the RIFF payload is cut short too.
	let mut long_chunk = LOSSY.to_vec();
	long_chunk[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
	assert_eq!(validate_avatar(&long_chunk), Err(AvatarError::Truncated));
	// And one too small to hold its own header cannot supply the dimensions.
	let mut tiny_chunk = LOSSY.to_vec();
	tiny_chunk[16..20].copy_from_slice(&4u32.to_le_bytes());
	assert_eq!(validate_avatar(&tiny_chunk), Err(AvatarError::Truncated));
}

#[test]
fn avatar_never_panics_on_corrupted_input() {
	for file in [LOSSY, LOSSLESS, ALPHA] {
		for i in 0..file.len().min(64) {
			for value in [0u8, 1, 0x7f, 0x80, 0xff] {
				let mut bytes = file.to_vec();
				bytes[i] = value;
				let _ = validate_avatar(&bytes);
			}
		}
	}
}

#[test]
fn name_accepts_lowercase_digits_dash_underscore() {
	for name in [&b"alice"[..], b"a_b-9", b"abc", b"0-9_a", &[b'a'; NAME_MAX as usize]] {
		assert_eq!(validate_name(name), Ok(()), "{name:?}");
	}
}

#[test]
fn name_rejects_non_ascii_and_uppercase() {
	let cyrillic_a = "\u{0430}lice";
	for name in
		[&b"Alice"[..], cyrillic_a.as_bytes(), b"al ice", b"alice.", b"al\0ce", b"\xff\xfe\xfd"]
	{
		assert_eq!(validate_name(name), Err(NameError::InvalidChar), "{name:?}");
	}
}

#[test]
fn name_rejects_lengths() {
	assert_eq!((NAME_MIN, NAME_MAX), (3, 32));
	assert_eq!(validate_name(b""), Err(NameError::TooShort));
	assert_eq!(validate_name(b"ab"), Err(NameError::TooShort));
	assert_eq!(validate_name(&[b'a'; 33]), Err(NameError::TooLong));
	assert_eq!(validate_name(&[b'a'; 1000]), Err(NameError::TooLong));
}

#[test]
fn pgp_lengths() {
	assert!(validate_pgp(&[0u8; 20]));
	assert!(validate_pgp(&[0u8; 32]));
	for len in [0, 19, 21, 31, 33, 40] {
		assert!(!validate_pgp(&vec![0u8; len]), "{len}");
	}
}

#[test]
fn utf8_check() {
	assert!(is_utf8(b""));
	assert!(is_utf8("été \u{1f600}".as_bytes()));
	assert!(!is_utf8(&[0xc3, 0x28]));
	assert!(!is_utf8(&[0xff]));
}
