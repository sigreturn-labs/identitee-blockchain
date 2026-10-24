//! `IdentiteeApi`: what clients read about identities without decoding storage.
//!
//! The runtime implements it with the pallet functions of the same names (`views.rs`,
//! `trust.rs`, `subs.rs`). Clients call it with `state_call("IdentiteeApi_<method>", SCALE args)`.

use crate::{
	types::TrustLevel,
	views::{NameStatus, ProfileView},
};
use alloc::vec::Vec;
use codec::Codec;

sp_api::decl_runtime_apis! {
	/// Read access to identities, names and sub-accounts.
	pub trait IdentiteeApi<AccountId, BlockNumber>
	where
		AccountId: Codec,
		BlockNumber: Codec,
	{
		/// The profile of `who`, `None` if it has no identity.
		fn profile(who: AccountId) -> Option<ProfileView<AccountId, BlockNumber>>;
		/// The trust level of `who`, `None` if it has no identity.
		fn trust_level(who: AccountId) -> Option<TrustLevel>;
		/// The account owning the name `name`, if any.
		fn resolve_name(name: Vec<u8>) -> Option<AccountId>;
		/// Whether `name` can be claimed now, and why not.
		fn name_status(name: Vec<u8>) -> NameStatus<AccountId, BlockNumber>;
		/// The accepted sub-accounts of `parent` with their labels, in the order it proposed them.
		fn subs_of(parent: AccountId) -> Vec<(AccountId, Vec<u8>)>;
		/// The proposals of `parent` not accepted yet, with their labels.
		fn pending_subs_of(parent: AccountId) -> Vec<(AccountId, Vec<u8>)>;
		/// The parent `sub` is an accepted member of, with the label it gave.
		fn parent_of(sub: AccountId) -> Option<(AccountId, Vec<u8>)>;
		/// The encrypted identity secret `who` stored, `None` if it has none.
		fn identity_secret(who: AccountId) -> Option<Vec<u8>>;
	}
}
