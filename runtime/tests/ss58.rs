//! The chain's SS58 prefix: 2426, which makes every address start with "id".

use identitee_runtime::{configs::SS58Prefix, Runtime};
use sp_core::crypto::{Ss58AddressFormat, Ss58Codec};
use sp_keyring::Sr25519Keyring;

#[test]
fn prefix_is_2426_everywhere() {
	assert_eq!(SS58Prefix::get(), 2426);
	assert_eq!(<Runtime as frame_system::Config>::SS58Prefix::get(), 2426);
}

#[test]
fn addresses_start_with_id() {
	let format = Ss58AddressFormat::custom(SS58Prefix::get());
	for keyring in [Sr25519Keyring::Alice, Sr25519Keyring::Bob, Sr25519Keyring::Eve] {
		let address = keyring.public().to_ss58check_with_version(format);
		assert!(address.starts_with("id"), "{address} does not start with \"id\"");
		assert_eq!(address.len(), 49, "{address}");
	}
}
