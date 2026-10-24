//! Opt-in migration of an identity from a People Chain.
//!
//! The person asks with `request_migration(source)`, which needs no identity on identitee yet;
//! one request per account, withdrawn with `cancel_migration`. An agent holding the migrate
//! capability (the migration service) reads the identity on the source chain at a finalised
//! block and gives it to `fulfil_migration`, or refuses with `reject_migration`. Both consume
//! the request.
//!
//! An account migrates once: an account with a migration history is refused
//! (`AlreadyMigrated`), so that clearing the identity and migrating again cannot bring back an
//! attestation or fact an authority revoked since. Only `kill_identity` (Root), which
//! deletes the history, allows another import.
//!
//! `fulfil_migration` checks the payload with the rules of the user writes (UTF-8 text, PGP
//! fingerprints, custom keys) and refuses the whole of it on the first invalid entry or on a key
//! or registrar given twice: cleaning the source data is the service's job, not the chain's. It
//! refuses as well if the account created an identity since its request.
//!
//! The judgements are mapped here, not by the service, so the rule is public and the same
//! for everyone. The judgement retained is the verdict of the first dotID registrar of the source
//! chain that gave one ([`DOTID_REGISTRARS`], in order of preference): a level that carries no
//! verdict (`FeePaid`, `Unknown`, `OutOfDate`) never masks the verdict of another dotID index.
//! The other registrars, and the levels without verdict, are kept in [`crate::ImportedHistory`]
//! only:
//!
//! | dotID judgement                  | on identitee                                         |
//! |----------------------------------|------------------------------------------------------|
//! | `Reasonable`                     | `Verified` attestation of every imported field       |
//! | `KnownGood`                      | the same, and a `DocumentChecked` fact               |
//! | `LowQuality`                     | `Rejected` attestation of every imported field       |
//! | `Erroneous`                      | a `Fraud` fact                                       |
//! | `OutOfDate`, `Unknown`, `FeePaid`| history only                                         |
//!
//! Imported fields are public. The attestations and facts are written for the agent's
//! authority, with the method `MigratedFromPeopleChain { source, registrar, block }` (which
//! `provide_judgement` refuses), no expiry, and count like any other for the trust level and names.
//! Facts have the reason `Unspecified` and an empty note. A fact of the same kind that the
//! authority already recorded about the person is left as it is (revoked or not, with its expiry,
//! reason and note): a migration never overwrites an authority's own decision.
//!
//! The history (source, block, block hash and every judgement as read) is provenance: clearing
//! the identity keeps it, like the facts, and it bars a second migration; `kill_identity`
//! deletes it.

use crate::{
	content::Slot,
	types::{
		commitment, AuthorityId, Capabilities, Fact, FactKind, FieldAttestation, FieldKey,
		FieldValue, Identity, JudgementLevel, Method, MigrationPayload, Note, ReasonCode,
		SourceChain, Verdict,
	},
	weights::Imported,
	Config, Error, Event, Facts, FieldAttestations, Identities, ImportedHistory, MigrationRequests,
	Pallet,
};
use alloc::vec::Vec;
use frame_support::{dispatch::DispatchResult, ensure};
use frame_system::pallet_prelude::BlockNumberFor;
use sp_core::H256;
use sp_runtime::DispatchError;

/// The registrar indices of dotID on each People Chain, the preferred one first: `#5` on
/// Polkadot; `#7` on Kusama, then its former index `#6`.
pub const DOTID_REGISTRARS: [(SourceChain, &[u32]); 2] =
	[(SourceChain::Polkadot, &[5]), (SourceChain::Kusama, &[7, 6])];

/// The dotID registrar indices of `source`, the preferred one first.
pub fn dotid_registrars(source: SourceChain) -> &'static [u32] {
	DOTID_REGISTRARS
		.iter()
		.find(|(chain, _)| *chain == source)
		.map_or(&[], |(_, registrars)| *registrars)
}

/// The judgement a migration from `source` retains, with its registrar index: the one of the
/// first dotID registrar of [`dotid_registrars`] whose judgement in `judgements` is a verdict
/// ([`is_verdict`]). A level without a verdict (`FeePaid`, `Unknown`, `OutOfDate`) never masks
/// the verdict of another dotID index.
pub fn dotid_judgement(
	source: SourceChain,
	judgements: &[(u32, JudgementLevel)],
) -> Option<(u32, JudgementLevel)> {
	dotid_registrars(source).iter().find_map(|registrar| {
		judgements
			.iter()
			.find(|(index, level)| index == registrar && is_verdict(*level))
			.copied()
	})
}

/// Whether a registrar judgement is a verdict on the identity: `Reasonable`, `KnownGood`,
/// `LowQuality` or `Erroneous`. `FeePaid` and `Unknown` say no check was made yet, `OutOfDate`
/// that the identity changed since the last one.
pub fn is_verdict(level: JudgementLevel) -> bool {
	matches!(
		level,
		JudgementLevel::Reasonable
			| JudgementLevel::KnownGood
			| JudgementLevel::LowQuality
			| JudgementLevel::Erroneous
	)
}

/// What a retained judgement becomes: the verdict of the attestation of every imported field,
/// and the fact recorded about the person (see the table of the module documentation).
pub fn judgement_effect(level: JudgementLevel) -> (Option<Verdict>, Option<FactKind>) {
	match level {
		JudgementLevel::Reasonable => (Some(Verdict::Verified), None),
		JudgementLevel::KnownGood => (Some(Verdict::Verified), Some(FactKind::DocumentChecked)),
		JudgementLevel::LowQuality => (Some(Verdict::Rejected), None),
		JudgementLevel::Erroneous => (None, Some(FactKind::Fraud)),
		JudgementLevel::OutOfDate | JudgementLevel::Unknown | JudgementLevel::FeePaid => {
			(None, None)
		},
	}
}

impl<T: Config> Pallet<T> {
	/// Ask for the migration of the caller's identity from `source`.
	pub(crate) fn do_request_migration(who: &T::AccountId, source: SourceChain) -> DispatchResult {
		ensure!(!Identities::<T>::contains_key(who), Error::<T>::IdentityExists);
		ensure!(!MigrationRequests::<T>::contains_key(who), Error::<T>::MigrationRequestExists);
		// A second import would bring back what an authority revoked since the first one: the
		// attestations and facts the migration wrote. Only Root, by purging the identity (and
		// with it the history), allows another one.
		ensure!(!ImportedHistory::<T>::contains_key(who), Error::<T>::AlreadyMigrated);
		MigrationRequests::<T>::insert(who, (source, frame_system::Pallet::<T>::block_number()));
		Self::deposit_event(Event::MigrationRequested { who: who.clone(), source });
		Ok(())
	}

	/// Withdraw the migration request of `who`.
	pub(crate) fn do_cancel_migration(who: &T::AccountId) -> DispatchResult {
		let (source, _) =
			MigrationRequests::<T>::take(who).ok_or(Error::<T>::NoMigrationRequest)?;
		Self::deposit_event(Event::MigrationCancelled { who: who.clone(), source });
		Ok(())
	}

	/// Refuse the migration request of `who`.
	pub(crate) fn do_reject_migration(
		agent: &T::AccountId,
		who: T::AccountId,
		reason: ReasonCode,
	) -> DispatchResult {
		Self::ensure_agent(agent, Capabilities::MIGRATE)?;
		let (source, _) =
			MigrationRequests::<T>::take(&who).ok_or(Error::<T>::NoMigrationRequest)?;
		Self::deposit_event(Event::MigrationRejected { who, source, reason, agent: agent.clone() });
		Ok(())
	}

	/// Create the identity of `who` from `payload`, read on `source` at `block` (`block_hash`),
	/// and map its dotID judgement; what was written besides the identity.
	pub(crate) fn do_fulfil_migration(
		agent: &T::AccountId,
		who: T::AccountId,
		source: SourceChain,
		block: u32,
		block_hash: H256,
		payload: MigrationPayload,
	) -> Result<Imported, DispatchError> {
		let authority = Self::ensure_agent(agent, Capabilities::MIGRATE)?;
		let (requested, _) =
			MigrationRequests::<T>::get(&who).ok_or(Error::<T>::NoMigrationRequest)?;
		ensure!(requested == source, Error::<T>::MigrationSourceMismatch);
		ensure!(!Identities::<T>::contains_key(&who), Error::<T>::IdentityExists);

		let now = frame_system::Pallet::<T>::block_number();
		let (identity, fields) = Self::imported_identity(&payload, now)?;
		let judgements = payload.judgements;
		for (i, (registrar, _)) in judgements.iter().enumerate() {
			ensure!(
				!judgements[..i].iter().any(|(earlier, _)| earlier == registrar),
				Error::<T>::DuplicateJudgement
			);
		}

		// Everything is checked: write.
		MigrationRequests::<T>::remove(&who);
		Identities::<T>::insert(&who, identity);
		for (key, _) in &fields {
			Self::deposit_event(Event::FieldSet { who: who.clone(), key: key.clone() });
		}

		let mut imported = Imported::default();
		if let Some((registrar, level)) = dotid_judgement(source, &judgements) {
			let (verdict, fact) = judgement_effect(level);
			if let Some(verdict) = verdict {
				let method = Method::MigratedFromPeopleChain { source, registrar, block };
				for (key, commitment) in fields {
					Self::import_attestation(
						agent, &who, authority, key, commitment, verdict, method,
					);
					imported.attestations += 1;
				}
			}
			if let Some(kind) = fact {
				if Self::import_fact(agent, &who, authority, kind) {
					imported.facts += 1;
				}
			}
		}

		ImportedHistory::<T>::insert(&who, (source, block, block_hash, judgements));
		Self::deposit_event(Event::MigrationFulfilled {
			who,
			source,
			block,
			block_hash,
			agent: agent.clone(),
		});
		Ok(imported)
	}

	/// The identity `payload` describes, created at `now`, with the key and commitment of each
	/// of its fields (typed, then custom). Fails on the first value that a user write would
	/// refuse, or on a key given twice.
	fn imported_identity(
		payload: &MigrationPayload,
		now: BlockNumberFor<T>,
	) -> Result<(Identity<BlockNumberFor<T>>, Vec<(FieldKey, H256)>), DispatchError> {
		let mut identity = Identity::new(now);
		let mut fields = Vec::with_capacity(payload.typed.len() + payload.custom.len());
		for (kind, value) in payload.typed.iter() {
			Self::check_public_value(&Slot::Typed(*kind), value)?;
			let value = FieldValue::Public(value.clone());
			fields.push((FieldKey::Typed(*kind), commitment(&value)));
			// Unreachable bound: the payload holds no more typed fields than an identity.
			let previous = identity
				.typed
				.try_insert(*kind, value)
				.map_err(|_| DispatchError::Other("typed field bound"))?;
			ensure!(previous.is_none(), Error::<T>::DuplicateField);
		}
		for (custom, value) in payload.custom.iter() {
			let key = FieldKey::Custom(custom.clone());
			let slot = Self::slot(&key)?;
			Self::check_public_value(&slot, value)?;
			let value = FieldValue::Public(value.clone());
			fields.push((key, commitment(&value)));
			let previous = identity
				.custom
				.try_insert(custom.clone(), value)
				.map_err(|_| Error::<T>::TooManyCustomFields)?;
			ensure!(previous.is_none(), Error::<T>::DuplicateField);
		}
		Ok((identity, fields))
	}

	/// Write the attestation of field `key` of `who` by `authority` that a migration derives
	/// from the retained judgement.
	fn import_attestation(
		agent: &T::AccountId,
		who: &T::AccountId,
		authority: AuthorityId,
		key: FieldKey,
		commitment: H256,
		verdict: Verdict,
		method: Method,
	) {
		FieldAttestations::<T>::insert(
			(who, &key, authority),
			FieldAttestation {
				commitment,
				verdict,
				method,
				issued_at: frame_system::Pallet::<T>::block_number(),
				expires_at: None,
				revoked: None,
			},
		);
		Self::deposit_event(Event::FieldAttested {
			who: who.clone(),
			key,
			authority,
			verdict,
			agent: agent.clone(),
		});
	}

	/// Record the fact about `who` that a migration derives from the retained judgement, unless
	/// the authority already has a fact of that kind about `who`: that one stays as it is,
	/// revoked or not, with its expiry, reason and note. Whether it wrote the fact.
	fn import_fact(
		agent: &T::AccountId,
		who: &T::AccountId,
		authority: AuthorityId,
		kind: FactKind,
	) -> bool {
		if Facts::<T>::contains_key(who, (kind, authority)) {
			return false;
		}
		Facts::<T>::insert(
			who,
			(kind, authority),
			Fact {
				issued_at: frame_system::Pallet::<T>::block_number(),
				expires_at: None,
				reason: ReasonCode::Unspecified,
				note: Note::default(),
				revoked: None,
			},
		);
		Self::deposit_event(Event::FactGranted {
			who: who.clone(),
			kind,
			authority,
			agent: agent.clone(),
		});
		true
	}
}
