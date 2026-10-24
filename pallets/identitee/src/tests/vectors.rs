//! Commitment test vectors, produced by the chain code (`types.rs`) and frozen here.
//!
//! The web front (`web/test/formulas.test.ts`) recomputes the same commitments in TypeScript and
//! must find exactly these values. `print_vectors` prints the table of inputs and outputs:
//!
//! ```text
//! cargo test -p pallet-identitee print_vectors -- --nocapture
//! ```
//!
//! `frozen_vectors` fails when a formula or a tag changes, which is the moment to change the
//! front and these constants together.

use crate::types::{
	commitment, link_commitment, private_commitment, FieldValue, LinkTitle, Value,
	LINK_COMMITMENT_TAG, PRIVATE_COMMITMENT_TAG, PUBLIC_COMMITMENT_TAG,
};
use codec::Encode;

fn hex(bytes: &[u8]) -> String {
	bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn value(text: &str) -> Value {
	Value::try_from(text.as_bytes().to_vec()).unwrap()
}

fn title(text: &str) -> LinkTitle {
	LinkTitle::try_from(text.as_bytes().to_vec()).unwrap()
}

/// Public values: an email, a url and non-ASCII text.
const PUBLIC: [&str; 3] = ["alice@example.org", "https://identit.ee/alice", "Zoë Müller 日本"];

/// Private values with their salt: a constant salt of 32 `0x11` bytes, then a counting one.
fn private() -> [([u8; 32], &'static str); 2] {
	let mut counting = [0u8; 32];
	for (i, byte) in counting.iter_mut().enumerate() {
		*byte = i as u8;
	}
	[([0x11; 32], "@alice"), (counting, "+33 6 12 34 56 78 é")]
}

/// Links as `(title, url)`.
const LINKS: [(&str, &str); 2] =
	[("Website", "https://identit.ee"), ("Café ☕", "https://example.org/ça?x=1&y=2")];

/// Links whose title or URL needs the two-byte compact length (64 bytes or more), built from
/// repeated pieces so that the front rebuilds the exact same strings:
///
/// - `boundary`: a title of exactly 64 bytes (the longest allowed, the first length that no
///   longer fits the one-byte mode) and a URL of exactly 64 bytes;
/// - `longest`: a title of 63 bytes (the longest in one-byte mode, 21 three-byte characters)
///   and a URL of 256 bytes (the longest allowed).
fn long_links() -> [(String, String); 2] {
	[
		("ab".repeat(32), format!("https://example.org/{}", "p".repeat(44))),
		("日".repeat(21), format!("https://example.org/?q={}", "z".repeat(233))),
	]
}

fn public_vectors() -> Vec<String> {
	PUBLIC
		.iter()
		.map(|v| hex(&commitment(&FieldValue::Public(value(v))).0))
		.collect()
}

fn private_vectors() -> Vec<String> {
	private()
		.iter()
		.map(|(salt, v)| hex(&private_commitment(salt, v.as_bytes()).0))
		.collect()
}

fn link_vectors() -> Vec<String> {
	LINKS
		.iter()
		.map(|(t, u)| hex(&link_commitment(&title(t), &value(u)).0))
		.collect()
}

fn long_link_vectors() -> Vec<String> {
	long_links()
		.iter()
		.map(|(t, u)| hex(&link_commitment(&title(t), &value(u)).0))
		.collect()
}

#[test]
fn print_vectors() {
	for tag in [PUBLIC_COMMITMENT_TAG, PRIVATE_COMMITMENT_TAG, LINK_COMMITMENT_TAG] {
		println!("tag     {}", String::from_utf8_lossy(tag));
	}
	for (v, out) in PUBLIC.iter().zip(public_vectors()) {
		println!("public  value={v:?} utf8={} => 0x{out}", hex(v.as_bytes()));
	}
	for ((salt, v), out) in private().iter().zip(private_vectors()) {
		println!("private salt=0x{} value={v:?} utf8={} => 0x{out}", hex(salt), hex(v.as_bytes()));
	}
	for ((t, u), out) in LINKS.iter().zip(link_vectors()) {
		println!(
			"link    title={t:?} url={u:?} scale=0x{} => 0x{out}",
			hex(&(title(t), value(u)).encode())
		);
	}
	for ((t, u), out) in long_links().iter().zip(long_link_vectors()) {
		let scale = (title(t), value(u)).encode();
		println!(
			"long    title={}B url={}B scale={}B starts 0x{} => 0x{out}",
			t.len(),
			u.len(),
			scale.len(),
			hex(&scale[..2])
		);
	}
}

#[test]
fn frozen_vectors() {
	assert_eq!(
		public_vectors(),
		[
			"887551424c678798e870359494a90539aaa32b2cdc7534dd08c291224af4f1f0",
			"92b4c07f22ef3a5bfd8b874906dff9ff726337813d0491c46dc9c6ff966514bd",
			"87fe6fbdde80876b6e2cf067912f030d098a96a4ec54f43ac9ad2ed0cdf3f9ed",
		],
		"public commitments changed: update web/test/formulas.test.ts"
	);
	assert_eq!(
		private_vectors(),
		[
			"f5c4e75938ab8ac7476576bcb45f29d463e79a85e7346e9ead40fc1088967de0",
			"2eb8078820d1e64b133d47b5050457a6a87594a8ce058baa7119cc3c036d7590",
		],
		"private commitments changed: update web/test/formulas.test.ts"
	);
	assert_eq!(
		link_vectors(),
		[
			"deb54bef5cbf0d79f25252ab40c026a0879ab56f956d3426f7d9d3026d8eb9e0",
			"6e912be3183cf1da26042f1dce060dffd462fcd90622438001eca37588fd0487",
		],
		"link commitments changed: update web/test/formulas.test.ts"
	);
	assert_eq!(
		long_link_vectors(),
		[
			"efea5d1599498d4c064fb0dcfff793ead2d1486ba74bf34c980960ac365a5c10",
			"cb9111f58296e8d3ccf1fa7cdd3a6560f98d72a796bd85084445cd956239f703",
		],
		"long link commitments changed: update web/test/formulas.test.ts"
	);
}

/// The two-byte compact length is what sets the long links apart from the short ones: check
/// that the vectors really use it, so they cannot silently stop covering it.
#[test]
fn long_links_use_two_byte_compact_lengths() {
	let [(boundary_title, boundary_url), (longest_title, longest_url)] = long_links();
	assert_eq!((boundary_title.len(), boundary_url.len()), (64, 64));
	assert_eq!((longest_title.len(), longest_url.len()), (63, 256));
	let boundary = (title(&boundary_title), value(&boundary_url)).encode();
	assert_eq!(&boundary[..2], [0x01, 0x01], "compact(64) is 0x0101");
	assert_eq!(&boundary[66..68], [0x01, 0x01]);
	let longest = (title(&longest_title), value(&longest_url)).encode();
	assert_eq!(longest[0], 63 << 2, "compact(63) is one byte");
	assert_eq!(&longest[64..66], [0x01, 0x04], "compact(256) is 0x0401");
}
