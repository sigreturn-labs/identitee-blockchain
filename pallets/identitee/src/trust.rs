//! The trust level of an identity: computed on demand, never stored.
//!
//! [`trust_level`] is the public rule, a pure function of a view of the
//! identity; [`Pallet::trust_level_of`] builds that view from storage. In this order:
//!
//! 1. no identity: no level;
//! 2. a `Fraud` fact is active: `Fraudulent`, whatever else holds;
//! 3. every verifiable typed field present has a valid `Verified` attestation and no valid
//!    `Rejected` one, and there is at least one such field: `FullyVerified`, or `Certified` if a
//!    `DocumentChecked` fact is active too;
//! 4. some field of any kind (typed, custom or link) has a valid `Verified` attestation and no
//!    valid `Rejected` one: `PartiallyVerified`;
//! 5. otherwise `Declared`.
//!
//! Verifiable fields are the typed fields for which an authority can check control
//! ([`FieldKind::is_verifiable`]): the names, the bio, the avatar, custom fields and links never
//! block `FullyVerified`. A field changed since it was attested, or added and not yet verified,
//! therefore blocks it. A rejected field does not count as verified: a valid `Rejected`
//! attestation from any authority takes the field out of both `FullyVerified` and
//! `PartiallyVerified`, even if another authority verified the same field.
//!
//! Facts about the person outlive `clear_identity` (see `attestations.rs`), but with no identity
//! there is no level: a fraud finding applies again when the identity is recreated.

use crate::{
	types::{FactKind, FieldKey, FieldKind, Identity, TrustLevel},
	Config, Facts, Identities, Pallet,
};
use alloc::vec::Vec;

/// The trust level of an identity, from a view of it.
///
/// - `identity`: the identity, `None` if there is none. It says which fields are present.
/// - `fields`: for field keys, whether an authority has a valid `Verified` attestation of it and
///   whether one has a valid `Rejected` one. A key may appear several times (one entry per
///   attestation, say): its entries are folded together. A present verifiable typed field that is
///   missing from here counts as unverified; a key the identity does not have is ignored.
/// - `facts`: for fact kinds, whether an authority's fact of that kind is active; a kind may appear
///   several times, and is active if one of its entries is.
pub fn trust_level<BlockNumber>(
	identity: Option<&Identity<BlockNumber>>,
	fields: &[(FieldKey, bool, bool)],
	facts: &[(FactKind, bool)],
) -> Option<TrustLevel> {
	let identity = identity?;
	let fact_active = |kind: FactKind| facts.iter().any(|(k, active)| *k == kind && *active);
	if fact_active(FactKind::Fraud) {
		return Some(TrustLevel::Fraudulent);
	}

	let flags = |key: &FieldKey| {
		fields
			.iter()
			.filter(|(k, ..)| k == key)
			.fold((false, false), |(v, r), (_, fv, fr)| (v || *fv, r || *fr))
	};
	let (mut verifiable, mut all_verified) = (0u32, true);
	for kind in identity.typed.keys().filter(|kind| FieldKind::is_verifiable(kind)) {
		let (verified, rejected) = flags(&FieldKey::Typed(*kind));
		verifiable += 1;
		all_verified &= verified && !rejected;
	}
	if verifiable > 0 && all_verified {
		return Some(if fact_active(FactKind::DocumentChecked) {
			TrustLevel::Certified
		} else {
			TrustLevel::FullyVerified
		});
	}

	let some_verified = fields.iter().any(|(key, ..)| {
		let (verified, rejected) = flags(key);
		verified && !rejected && is_present(identity, key)
	});
	Some(if some_verified { TrustLevel::PartiallyVerified } else { TrustLevel::Declared })
}

/// The keys of every field of `identity`: typed, custom and links.
pub(crate) fn field_keys<BlockNumber>(
	identity: &Identity<BlockNumber>,
) -> impl Iterator<Item = FieldKey> + '_ {
	let typed = identity.typed.keys().map(|kind| FieldKey::Typed(*kind));
	let custom = identity.custom.keys().map(|key| FieldKey::Custom(key.clone()));
	let links = identity.links.iter().map(|link| FieldKey::Link(link.id));
	typed.chain(custom).chain(links)
}

/// Whether `identity` has the field `key`.
fn is_present<BlockNumber>(identity: &Identity<BlockNumber>, key: &FieldKey) -> bool {
	match key {
		FieldKey::Typed(kind) => identity.typed.contains_key(kind),
		FieldKey::Custom(custom) => identity.custom.contains_key(custom),
		FieldKey::Link(id) => identity.links.iter().any(|link| link.id == *id),
	}
}

impl<T: Config> Pallet<T> {
	/// The trust level of `who` now, `None` if it has no identity.
	///
	/// Reads the identity once, then for each of its fields the attestations of every authority
	/// (at most [`crate::limits::MAX_AUTHORITIES`]), and the facts about the person (at most
	/// one per kind and authority). Meant for the runtime API, not for dispatch.
	pub fn trust_level_of(who: &T::AccountId) -> Option<TrustLevel> {
		let identity = Identities::<T>::get(who)?;
		let now = frame_system::Pallet::<T>::block_number();

		let fields: Vec<(FieldKey, bool, bool)> = field_keys(&identity)
			.map(|key| {
				let verdicts = Self::field_verdicts(who, &identity, &key, now);
				(key, verdicts.verified, verdicts.rejected)
			})
			.collect();
		let facts: Vec<(FactKind, bool)> = Facts::<T>::iter_prefix(who)
			.map(|((kind, _authority), fact)| (kind, Self::fact_is_active(&fact, now)))
			.collect();

		trust_level(Some(&identity), &fields, &facts)
	}
}
