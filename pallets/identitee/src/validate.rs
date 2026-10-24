//! Pure validators for avatar images, names, PGP fingerprints and UTF-8 text.
//!
//! Nothing here touches storage or FRAME types: the module is `no_std`, compiles into the wasm
//! runtime and is equally usable from plain unit tests. Limits come from [`crate::limits`].

use crate::limits::{AVATAR_SIZES, MAX_AVATAR_LEN, NAME_MAX, NAME_MIN};

/// Why an avatar was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AvatarError {
	/// More than [`MAX_AVATAR_LEN`] bytes.
	TooLarge,
	/// Not a RIFF/WEBP container, or the bitstream signature of the first chunk is wrong.
	NotWebp,
	/// The first chunk is none of `VP8 `, `VP8L` and `VP8X`.
	UnsupportedChunk,
	/// The input ends before the dimensions can be read, or the container sizes announce more
	/// bytes than are present.
	Truncated,
	/// The dimensions are not one of [`AVATAR_SIZES`].
	BadDimensions,
}

/// Why a name was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NameError {
	/// Shorter than [`NAME_MIN`] bytes.
	TooShort,
	/// Longer than [`NAME_MAX`] bytes.
	TooLong,
	/// Contains a byte outside `a-z`, `0-9`, `-` and `_`.
	InvalidChar,
}

/// Length of the RIFF header: `RIFF`, 32-bit size, `WEBP`.
const RIFF_HEADER_LEN: usize = 12;
/// Length of a chunk header: four-character code and 32-bit size.
const CHUNK_HEADER_LEN: usize = 8;

/// Check that `bytes` is a WebP image of an accepted size, from its headers alone.
///
/// Only the container and the first chunk are read, so the cost does not depend on the image and
/// nothing is decoded: corrupt pixel data behind a valid header passes. That is accepted: decoding
/// on chain would cost far more, and clients render the image anyway. The accepted first chunks are
/// `VP8 ` (lossy), `VP8L` (lossless) and `VP8X` (extended, whose canvas size is checked). Every
/// access is bounds-checked, and the RIFF size field is never trusted beyond the buffer: a file
/// that announces more bytes than it holds is [`AvatarError::Truncated`]. Bytes after the announced
/// RIFF payload are ignored, as the format allows.
pub fn validate_avatar(bytes: &[u8]) -> Result<(), AvatarError> {
	if bytes.len() > MAX_AVATAR_LEN as usize {
		return Err(AvatarError::TooLarge);
	}
	expect_magic(bytes, 0, b"RIFF")?;
	expect_magic(bytes, 8, b"WEBP")?;
	// Everything below reads from `riff`, so no chunk can reach past what the container announced
	// nor past the buffer. u64 first: `size + 8` overflows a 32-bit `usize` (the wasm runtime)
	// when the field is hostile, and the conversion back then fails instead of wrapping.
	let riff = usize::try_from(u64::from(read_u32_le(bytes, 4)?) + 8)
		.ok()
		.and_then(|end| bytes.get(..end))
		.ok_or(AvatarError::Truncated)?;

	let code = riff.get(RIFF_HEADER_LEN..RIFF_HEADER_LEN + 4).ok_or(AvatarError::Truncated)?;
	let size = read_u32_le(riff, RIFF_HEADER_LEN + 4)?;
	let header: fn(&[u8]) -> Result<(u32, u32), AvatarError> = match code {
		b"VP8 " => vp8_dimensions,
		b"VP8L" => vp8l_dimensions,
		b"VP8X" => vp8x_dimensions,
		_ => return Err(AvatarError::UnsupportedChunk),
	};
	let payload = riff
		.get(RIFF_HEADER_LEN + CHUNK_HEADER_LEN..)
		.and_then(|rest| rest.get(..size as usize))
		.ok_or(AvatarError::Truncated)?;

	let (width, height) = header(payload)?;
	if AVATAR_SIZES.contains(&(width, height)) {
		Ok(())
	} else {
		Err(AvatarError::BadDimensions)
	}
}

/// Check the bytes present at `offset` against `magic`.
///
/// A mismatch on a byte that is there wins over a missing byte after it, so a short PNG prefix
/// is [`AvatarError::NotWebp`] and not [`AvatarError::Truncated`].
fn expect_magic(bytes: &[u8], offset: usize, magic: &[u8]) -> Result<(), AvatarError> {
	for (i, expected) in magic.iter().enumerate() {
		match bytes.get(offset + i) {
			Some(byte) if byte == expected => {},
			Some(_) => return Err(AvatarError::NotWebp),
			None => return Err(AvatarError::Truncated),
		}
	}
	Ok(())
}

fn read_u32_le(bytes: &[u8], offset: usize) -> Result<u32, AvatarError> {
	let field = bytes.get(offset..offset + 4).ok_or(AvatarError::Truncated)?;
	Ok(u32::from_le_bytes([field[0], field[1], field[2], field[3]]))
}

/// `VP8 ` payload: 3-byte frame tag, start code `9d 01 2a`, then 16-bit little-endian width and
/// height, each holding 14 bits of size under 2 bits of scaling hint.
fn vp8_dimensions(payload: &[u8]) -> Result<(u32, u32), AvatarError> {
	let head = payload.get(..10).ok_or(AvatarError::Truncated)?;
	if head[3..6] != [0x9d, 0x01, 0x2a] {
		return Err(AvatarError::NotWebp);
	}
	let width = u32::from(u16::from_le_bytes([head[6], head[7]]) & 0x3fff);
	let height = u32::from(u16::from_le_bytes([head[8], head[9]]) & 0x3fff);
	Ok((width, height))
}

/// `VP8L` payload: signature `0x2f`, then 14 bits of width-1 and 14 bits of height-1.
fn vp8l_dimensions(payload: &[u8]) -> Result<(u32, u32), AvatarError> {
	let head = payload.get(..5).ok_or(AvatarError::Truncated)?;
	if head[0] != 0x2f {
		return Err(AvatarError::NotWebp);
	}
	let bits = u32::from_le_bytes([head[1], head[2], head[3], head[4]]);
	Ok(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
}

/// `VP8X` payload: flags, 3 reserved bytes, then 24-bit canvas width-1 and height-1.
fn vp8x_dimensions(payload: &[u8]) -> Result<(u32, u32), AvatarError> {
	let head = payload.get(..10).ok_or(AvatarError::Truncated)?;
	let width = u32::from_le_bytes([head[4], head[5], head[6], 0]) + 1;
	let height = u32::from_le_bytes([head[7], head[8], head[9], 0]) + 1;
	Ok((width, height))
}

/// Check a name: [`NAME_MIN`] to [`NAME_MAX`] bytes, each one of `a-z`, `0-9`, `-` and `_`.
///
/// The alphabet is ASCII-only on purpose (no homoglyphs, no case folding), so the length in
/// bytes is the length in characters. The length is checked first.
pub fn validate_name(name: &[u8]) -> Result<(), NameError> {
	if name.len() < NAME_MIN as usize {
		return Err(NameError::TooShort);
	}
	if name.len() > NAME_MAX as usize {
		return Err(NameError::TooLong);
	}
	if name.iter().all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_')) {
		Ok(())
	} else {
		Err(NameError::InvalidChar)
	}
}

/// Whether `bytes` has the length of a PGP fingerprint: 20 bytes (v4) or 32 bytes (v6).
pub fn validate_pgp(bytes: &[u8]) -> bool {
	matches!(bytes.len(), 20 | 32)
}

/// Whether `bytes` is valid UTF-8.
pub fn is_utf8(bytes: &[u8]) -> bool {
	core::str::from_utf8(bytes).is_ok()
}
