//! Read-only views of the pallet's state, as the runtime API returns them (`runtime_api.rs`).
//!
//! Each view is built from storage on demand, at the block the API is called at; validity of
//! attestations, activity of facts and the trust level are computed for that block, never stored.
//! The views are SCALE types: their variant and field order is part of the API.

use crate::{
	trust::trust_level,
	types::{
		AuthorityId, Fact, FactKind, FieldAttestation, FieldKey, Identity, JudgementLevel, Name,
		SourceChain, TrustLevel, Verdict,
	},
	validate, Config, Facts, FieldAttestations, Identities, IdentitySecrets, ImportedHistory,
	NameOf, NameOwner, Pallet, Quarantine, Reserved,
};
use alloc::vec::Vec;
use codec::{Decode, DecodeWithMemTracking, Encode};
use frame_system::pallet_prelude::BlockNumberFor;
use scale_info::TypeInfo;
use sp_core::H256;

/// Everything public about an identity.
#[derive(Encode, Decode, DecodeWithMemTracking, Clone, PartialEq, Eq, Debug, TypeInfo)]
pub struct ProfileView<AccountId, BlockNumber> {
	/// The identity itself, avatar bytes included.
	pub identity: Identity<BlockNumber>,
	/// Its native name, if it has one.
	pub name: Option<Vec<u8>>,
	/// Its trust level now.
	pub trust_level: TrustLevel,
	/// Every attestation of its fields, by field and authority, with whether it is valid now
	/// (not revoked, not expired, and the field still has the attested value).
	pub attestations: Vec<(FieldKey, AuthorityId, FieldAttestation<BlockNumber>, bool)>,
	/// Every fact about the person, by kind and authority, with whether it is active now.
	pub facts: Vec<(FactKind, AuthorityId, Fact<BlockNumber>, bool)>,
	/// The parent it is an accepted member of, with the label the parent gave it.
	pub parent: Option<(AccountId, Vec<u8>)>,
	/// Its accepted sub-accounts with their labels, in the order it proposed them. Pending
	/// proposals are not members and are not listed here.
	pub subs: Vec<(AccountId, Vec<u8>)>,
	/// Where it was migrated from, if it was.
	pub imported: Option<ImportedView>,
}

/// The provenance of a migrated identity (`ImportedHistory`).
#[derive(Encode, Decode, DecodeWithMemTracking, Clone, PartialEq, Eq, Debug, TypeInfo)]
pub struct ImportedView {
	/// The People Chain it came from.
	pub source: SourceChain,
	/// The source block it was read at.
	pub block: u32,
	/// The hash of that block.
	pub block_hash: H256,
	/// Every registrar judgement as read there: `(registrar index, judgement)`.
	pub judgements: Vec<(u32, JudgementLevel)>,
}

/// Whether a name can be claimed, and why not.
#[derive(Encode, Decode, DecodeWithMemTracking, Clone, PartialEq, Eq, Debug, TypeInfo)]
pub enum NameStatus<AccountId, BlockNumber> {
	/// Not a valid name: length or alphabet (see [`crate::validate::validate_name`]).
	Invalid,
	/// Owned by this account.
	Taken(AccountId),
	/// Reserved: only an authority can assign it.
	Reserved,
	/// Released or revoked recently: claimable from block `until` on.
	Quarantined { until: BlockNumber },
	/// Free. A claim still needs a verified field and no cooldown on the claiming account.
	Available,
}

impl<T: Config> Pallet<T> {
	/// The profile of `who` now, `None` if it has no identity. Facts about the person and the
	/// migration history outlive `clear_identity`, but without an identity there is no profile.
	pub fn profile(who: &T::AccountId) -> Option<ProfileView<T::AccountId, BlockNumberFor<T>>> {
		let identity = Identities::<T>::get(who)?;
		let now = frame_system::Pallet::<T>::block_number();

		let attestations: Vec<_> = FieldAttestations::<T>::iter_prefix((who,))
			.map(|((key, authority), att)| {
				let current = Self::commitment_in(&identity, &key);
				let valid = Self::attestation_is_valid_against(&att, current, now);
				(key, authority, att, valid)
			})
			.collect();
		let facts: Vec<_> = Facts::<T>::iter_prefix(who)
			.map(|((kind, authority), fact)| {
				let active = Self::fact_is_active(&fact, now);
				(kind, authority, fact, active)
			})
			.collect();

		let fields: Vec<(FieldKey, bool, bool)> = attestations
			.iter()
			.map(|(key, _, att, valid)| {
				(
					key.clone(),
					*valid && att.verdict == Verdict::Verified,
					*valid && att.verdict == Verdict::Rejected,
				)
			})
			.collect();
		let fact_flags: Vec<(FactKind, bool)> =
			facts.iter().map(|(kind, _, _, active)| (*kind, *active)).collect();
		// Some: the identity is there.
		let trust_level = trust_level(Some(&identity), &fields, &fact_flags)?;

		let imported = ImportedHistory::<T>::get(who).map(|(source, block, block_hash, list)| {
			ImportedView { source, block, block_hash, judgements: list.into_inner() }
		});
		Some(ProfileView {
			identity,
			name: NameOf::<T>::get(who).map(Name::into_inner),
			trust_level,
			attestations,
			facts,
			parent: Self::parent_of(who),
			subs: Self::subs_of(who),
			imported,
		})
	}

	/// The encrypted identity secret stored by `who`, exactly as it was given.
	pub fn identity_secret(who: &T::AccountId) -> Option<Vec<u8>> {
		IdentitySecrets::<T>::get(who).map(|blob| blob.into_inner())
	}

	/// The account owning the name `name`, if any.
	pub fn resolve_name(name: &[u8]) -> Option<T::AccountId> {
		Self::resolve(&Name::try_from(name.to_vec()).ok()?)
	}

	/// Whether `name` can be claimed now. A quarantine whose block has come is over, even while
	/// its entry is still stored.
	pub fn name_status(name: &[u8]) -> NameStatus<T::AccountId, BlockNumberFor<T>> {
		if validate::validate_name(name).is_err() {
			return NameStatus::Invalid;
		}
		let Ok(name) = Name::try_from(name.to_vec()) else { return NameStatus::Invalid };
		if let Some(owner) = NameOwner::<T>::get(&name) {
			return NameStatus::Taken(owner);
		}
		if Reserved::<T>::contains_key(&name) {
			return NameStatus::Reserved;
		}
		match Quarantine::<T>::get(&name) {
			Some(until) if frame_system::Pallet::<T>::block_number() < until => {
				NameStatus::Quarantined { until }
			},
			_ => NameStatus::Available,
		}
	}
}
