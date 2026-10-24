//! Identity content: typed and custom fields, links, bio, avatar, the whole-profile update,
//! reveal and clearing.

use crate::{
	types::{
		private_commitment, AvatarBytes, Bio, CustomKey, FieldChanges, FieldKey, FieldKind,
		FieldValue, Identity, Link, LinkEdit, LinkIds, LinkTitle, MaxLinks, ProfileUpdate,
		SecretBlob, Value,
	},
	validate,
	weights::{Cleared, ProfileWork},
	Config, Error, Event, Identities, IdentitySecrets, Pallet, WeightInfo,
};
use alloc::vec::Vec;
use frame_support::{
	dispatch::{DispatchResult, DispatchResultWithPostInfo},
	ensure, BoundedVec,
};
use frame_system::pallet_prelude::BlockNumberFor;
use sp_core::H256;
use sp_runtime::DispatchError;

/// Where a non-link [`FieldKey`] points.
pub(crate) enum Slot {
	Typed(FieldKind),
	Custom(CustomKey),
}

impl<T: Config> Pallet<T> {
	/// Set the bio of `who`, creating the identity if it does not exist yet.
	pub(crate) fn do_set_bio(who: &T::AccountId, bio: Bio) -> DispatchResult {
		ensure!(validate::is_utf8(&bio), Error::<T>::InvalidUtf8);
		Self::mutate_or_create(who, |identity| {
			identity.bio = bio;
			Ok(())
		})?;
		Self::deposit_event(Event::BioSet { who: who.clone() });
		Ok(())
	}

	/// Store `blob` as the identity secret of `who`, replacing the one it had. The bytes are
	/// opaque to the chain; an empty blob is refused, `do_clear_identity_secret` is the way to
	/// delete. No identity is needed.
	pub(crate) fn do_set_identity_secret(who: &T::AccountId, blob: SecretBlob) -> DispatchResult {
		ensure!(!blob.is_empty(), Error::<T>::EmptySecretBlob);
		IdentitySecrets::<T>::insert(who, blob);
		Self::deposit_event(Event::IdentitySecretSet { who: who.clone() });
		Ok(())
	}

	/// Delete the identity secret of `who`. Deleting an absent one succeeds (and emits the
	/// event), so a client can clear without reading first.
	pub(crate) fn do_clear_identity_secret(who: &T::AccountId) {
		IdentitySecrets::<T>::remove(who);
		Self::deposit_event(Event::IdentitySecretCleared { who: who.clone() });
	}

	/// Set a typed or custom field of `who`, creating the identity if needed.
	pub(crate) fn do_set_field(
		who: &T::AccountId,
		key: FieldKey,
		value: FieldValue,
	) -> DispatchResult {
		let slot = Self::slot(&key)?;
		if let FieldValue::Public(v) = &value {
			Self::check_public_value(&slot, v)?;
		}
		Self::mutate_or_create(who, |identity| Self::write_slot(identity, slot, value))?;
		Self::deposit_event(Event::FieldSet { who: who.clone(), key });
		Ok(())
	}

	/// Remove a typed or custom field of `who`, with its attestations. Removing an absent field
	/// succeeds (and emits the event), so a client can clear without reading first.
	pub(crate) fn do_clear_field(who: &T::AccountId, key: FieldKey) -> DispatchResult {
		let slot = Self::slot(&key)?;
		Self::mutate_existing(who, |identity| {
			match slot {
				Slot::Typed(kind) => {
					identity.typed.remove(&kind);
				},
				Slot::Custom(custom) => {
					identity.custom.remove(&custom);
				},
			}
			Ok(())
		})?;
		Self::remove_field_attestations(who, &key);
		Self::deposit_event(Event::FieldCleared { who: who.clone(), key });
		Ok(())
	}

	/// Apply `changes` to the fields of `who` in order, each as [`Self::do_set_field`] or
	/// [`Self::do_clear_field`] does, so a change is checked exactly like its single call. The
	/// caller's storage layer makes the whole call atomic: if one change fails, none is kept.
	///
	/// Reports the weight of the changes started, whether it succeeded or not.
	pub(crate) fn do_set_identity(
		who: &T::AccountId,
		changes: FieldChanges,
	) -> DispatchResultWithPostInfo {
		let mut started = 0;
		Self::apply_field_changes(who, changes, &mut started)
			.map_err(|e| Self::failed(T::WeightInfo::set_identity_actual(started), e))?;
		Ok(Self::used(T::WeightInfo::set_identity_actual(started)))
	}

	/// The body of [`Self::do_set_identity`], shared with `update_profile`: refuse a key given
	/// twice, then apply each change. `started` counts the changes started, for the weight.
	fn apply_field_changes(
		who: &T::AccountId,
		changes: FieldChanges,
		started: &mut u32,
	) -> DispatchResult {
		let has_duplicate = changes
			.iter()
			.enumerate()
			.any(|(i, (key, _))| changes[..i].iter().any(|(earlier, _)| earlier == key));
		ensure!(!has_duplicate, Error::<T>::DuplicateFieldInBatch);
		for (key, change) in changes {
			*started += 1;
			match change {
				Some(value) => Self::do_set_field(who, key, value),
				None => Self::do_clear_field(who, key),
			}?;
		}
		Ok(())
	}

	/// Append a link to the identity of `who`, creating the identity if needed; the id it got.
	pub(crate) fn do_add_link(
		who: &T::AccountId,
		title: LinkTitle,
		url: Value,
	) -> Result<u32, DispatchError> {
		Self::check_link(&title, &url)?;
		let mut added = 0;
		Self::mutate_or_create(who, |identity| {
			let id = identity.next_link_id;
			identity
				.links
				.try_push(Link { id, title, url })
				.map_err(|_| Error::<T>::TooManyLinks)?;
			identity.next_link_id = id.checked_add(1).ok_or(Error::<T>::TooManyLinks)?;
			added = id;
			Ok(())
		})?;
		Self::deposit_event(Event::LinkAdded { who: who.clone(), id: added });
		Ok(added)
	}

	/// Replace the title and url of link `id`, keeping its id and position.
	pub(crate) fn do_update_link(
		who: &T::AccountId,
		id: u32,
		title: LinkTitle,
		url: Value,
	) -> DispatchResult {
		Self::check_link(&title, &url)?;
		Self::mutate_existing(who, |identity| {
			let link = identity
				.links
				.iter_mut()
				.find(|link| link.id == id)
				.ok_or(Error::<T>::UnknownLink)?;
			link.title = title;
			link.url = url;
			Ok(())
		})?;
		Self::deposit_event(Event::LinkUpdated { who: who.clone(), id });
		Ok(())
	}

	/// Remove link `id`, with its attestations. Its id is never given again.
	pub(crate) fn do_remove_link(who: &T::AccountId, id: u32) -> DispatchResult {
		Self::mutate_existing(who, |identity| {
			let position = identity
				.links
				.iter()
				.position(|link| link.id == id)
				.ok_or(Error::<T>::UnknownLink)?;
			identity.links.remove(position);
			Ok(())
		})?;
		Self::remove_field_attestations(who, &FieldKey::Link(id));
		Self::deposit_event(Event::LinkRemoved { who: who.clone(), id });
		Ok(())
	}

	/// Put the links in the order of `ids`, which must list every current link exactly once.
	pub(crate) fn do_reorder_links(who: &T::AccountId, ids: LinkIds) -> DispatchResult {
		Self::mutate_existing(who, |identity| {
			ensure!(ids.len() == identity.links.len(), Error::<T>::InvalidLinkOrder);
			let mut remaining: Vec<Option<Link>> =
				identity.links.iter().cloned().map(Some).collect();
			let mut ordered = Vec::with_capacity(ids.len());
			for id in ids.iter() {
				// Taking each link out makes a repeated id fail like an unknown one.
				let link = remaining
					.iter_mut()
					.find(|slot| slot.as_ref().is_some_and(|link| link.id == *id))
					.and_then(Option::take)
					.ok_or(Error::<T>::InvalidLinkOrder)?;
				ordered.push(link);
			}
			// Same length as the current bounded list, so this cannot fail.
			identity.links =
				BoundedVec::try_from(ordered).map_err(|_| Error::<T>::InvalidLinkOrder)?;
			Ok(())
		})?;
		Self::deposit_event(Event::LinksReordered { who: who.clone() });
		Ok(())
	}

	/// Set the avatar of `who` (a WebP image of an accepted size), creating the identity if
	/// needed.
	pub(crate) fn do_set_avatar(who: &T::AccountId, bytes: AvatarBytes) -> DispatchResult {
		ensure!(validate::validate_avatar(&bytes).is_ok(), Error::<T>::InvalidAvatar);
		Self::mutate_or_create(who, |identity| {
			identity.avatar = Some(bytes);
			Ok(())
		})?;
		Self::deposit_event(Event::AvatarSet { who: who.clone() });
		Ok(())
	}

	/// Remove the avatar of `who`.
	pub(crate) fn do_clear_avatar(who: &T::AccountId) -> DispatchResult {
		Self::mutate_existing(who, |identity| {
			identity.avatar = None;
			Ok(())
		})?;
		Self::deposit_event(Event::AvatarCleared { who: who.clone() });
		Ok(())
	}

	/// Apply `update` to the profile of `who`: the identity secret, the bio, the avatar, the
	/// fields, then the links, each part through the helper of its single call, so it is checked
	/// and emits events exactly as that call does. The caller's storage layer makes the whole
	/// call atomic: if one step fails, none is kept.
	///
	/// Reports the weight of the steps started, whether it succeeded or not.
	pub(crate) fn do_update_profile(
		who: &T::AccountId,
		update: ProfileUpdate,
	) -> DispatchResultWithPostInfo {
		let mut work = ProfileWork::default();
		Self::apply_profile_update(who, update, &mut work)
			.map_err(|e| Self::failed(T::WeightInfo::update_profile_actual(work), e))?;
		Self::deposit_event(Event::ProfileUpdated { who: who.clone() });
		Ok(Self::used(T::WeightInfo::update_profile_actual(work)))
	}

	/// The steps of [`Self::do_update_profile`], each recorded in `work` when it starts.
	fn apply_profile_update(
		who: &T::AccountId,
		update: ProfileUpdate,
		work: &mut ProfileWork,
	) -> DispatchResult {
		let ProfileUpdate { bio, avatar, fields, links, secret } = update;
		let changes_something = secret.is_some()
			|| bio.is_some()
			|| avatar.is_some()
			|| !fields.is_empty()
			|| match &links {
				Some(edits) => {
					work.links_read = true;
					Self::link_edits_change_something(who, edits)
				},
				None => false,
			};
		ensure!(changes_something, Error::<T>::EmptyUpdate);
		if let Some(blob) = secret {
			work.secret = true;
			Self::do_set_identity_secret(who, blob)?;
		}
		if let Some(bio) = bio {
			work.bio = true;
			Self::do_set_bio(who, bio)?;
		}
		if let Some(avatar) = avatar {
			work.avatar = true;
			match avatar {
				Some(bytes) => Self::do_set_avatar(who, bytes)?,
				None => Self::do_clear_avatar(who)?,
			}
		}
		Self::apply_field_changes(who, fields, &mut work.field_changes)?;
		if let Some(edits) = links {
			Self::apply_link_edits(who, edits, work)?;
		}
		Ok(())
	}

	/// Whether `edits` would change the links of `who`: anything but keeping every current link,
	/// in its order (an empty list when there is no link is no change either).
	fn link_edits_change_something(who: &T::AccountId, edits: &[LinkEdit]) -> bool {
		let current: Vec<u32> = Identities::<T>::get(who)
			.map(|identity| identity.links.iter().map(|link| link.id).collect())
			.unwrap_or_default();
		current.len() != edits.len()
			|| current
				.iter()
				.zip(edits)
				.any(|(id, edit)| !matches!(edit, LinkEdit::Keep(kept) if kept == id))
	}

	/// Make the links of `who` exactly `edits`, in its order: remove the current links it does
	/// not name, update and add as the single calls do, then reorder if the result is not in the
	/// order of the list. Every id it names is checked before anything changes.
	fn apply_link_edits(
		who: &T::AccountId,
		edits: BoundedVec<LinkEdit, MaxLinks>,
		work: &mut ProfileWork,
	) -> DispatchResult {
		work.links_read = true;
		let current: Vec<u32> = Identities::<T>::get(who)
			.map(|identity| identity.links.iter().map(|link| link.id).collect())
			.unwrap_or_default();
		let mut named = Vec::with_capacity(edits.len());
		for edit in edits.iter() {
			let (LinkEdit::Keep(id) | LinkEdit::Update { id, .. }) = edit else { continue };
			ensure!(!named.contains(id), Error::<T>::InvalidLinkOrder);
			ensure!(current.contains(id), Error::<T>::UnknownLink);
			named.push(*id);
		}

		// What is left of the current links keeps its order; added links come after it.
		let mut resulting: Vec<u32> = Vec::with_capacity(edits.len());
		for id in current {
			if named.contains(&id) {
				resulting.push(id);
			} else {
				work.link_edits += 1;
				Self::do_remove_link(who, id)?;
			}
		}
		for edit in edits.iter() {
			if let LinkEdit::Update { id, title, url } = edit {
				work.link_edits += 1;
				Self::do_update_link(who, *id, title.clone(), url.clone())?;
			}
		}
		let mut wanted = Vec::with_capacity(edits.len());
		for edit in edits {
			match edit {
				LinkEdit::Keep(id) | LinkEdit::Update { id, .. } => wanted.push(id),
				LinkEdit::Add { title, url } => {
					work.link_edits += 1;
					let id = Self::do_add_link(who, title, url)?;
					resulting.push(id);
					wanted.push(id);
				},
			}
		}

		if resulting != wanted {
			work.reorder = true;
			// No longer than the list, so this cannot fail.
			let ids = LinkIds::try_from(wanted).map_err(|_| Error::<T>::InvalidLinkOrder)?;
			Self::do_reorder_links(who, ids)?;
		}
		Ok(())
	}

	/// Turn a private field into a public one by giving the value and salt behind its
	/// commitment [`private_commitment`]. The revealed value is checked like any public
	/// value of that field. Attestations of the private commitment are moved to the public one
	/// and stay valid.
	pub(crate) fn do_reveal_field(
		who: &T::AccountId,
		key: FieldKey,
		value: Value,
		salt: [u8; 32],
	) -> DispatchResult {
		let slot = Self::slot(&key)?;
		let mut old = H256::zero();
		Self::mutate_existing(who, |identity| {
			let current = match &slot {
				Slot::Typed(kind) => identity.typed.get(kind),
				Slot::Custom(custom) => identity.custom.get(custom),
			};
			// An absent field has nothing to reveal either.
			let Some(FieldValue::Private(hash)) = current else {
				return Err(Error::<T>::NotPrivate.into());
			};
			ensure!(private_commitment(&salt, &value) == *hash, Error::<T>::RevealMismatch);
			Self::check_public_value(&slot, &value)?;
			old = *hash;
			Self::write_slot(identity, slot, FieldValue::Public(value.clone()))
		})?;
		// The attestations of the private value now commit to the public one.
		Self::on_field_revealed(who, &key, old, &value);
		Self::deposit_event(Event::FieldRevealed { who: who.clone(), key });
		Ok(())
	}

	/// Delete the identity of `who` and everything attached to it, except the facts about the
	/// person (see `attestations.rs`); what was deleted besides the identity.
	///
	/// The account's provider reference and `ProviderHeld` are kept, so the account and its nonce
	/// survive and old feeless transactions cannot be replayed.
	pub(crate) fn do_clear_identity(who: &T::AccountId) -> Result<Cleared, DispatchError> {
		ensure!(Identities::<T>::contains_key(who), Error::<T>::NoIdentity);
		Identities::<T>::remove(who);
		Ok(Self::on_identity_cleared(who))
	}

	/// Cleanup of what other modules attach to an identity, run when it is cleared; what was
	/// deleted.
	fn on_identity_cleared(who: &T::AccountId) -> Cleared {
		let (attestations, requests) = Self::clear_attestations(who);
		let name = Self::release_name_on_identity_cleared(who);
		let subs = Self::drop_subs_on_identity_cleared(who);
		Cleared { attestations, requests, facts: 0, name, subs, history: false, secret: false }
	}

	/// Apply `f` to the identity of `who`, created empty if absent, and stamp `updated_at`.
	/// Nothing is written if `f` fails.
	fn mutate_or_create(
		who: &T::AccountId,
		f: impl FnOnce(&mut Identity<BlockNumberFor<T>>) -> DispatchResult,
	) -> DispatchResult {
		let now = frame_system::Pallet::<T>::block_number();
		Identities::<T>::try_mutate(who, |slot| {
			let identity = slot.get_or_insert_with(|| Identity::new(now));
			f(identity)?;
			identity.updated_at = now;
			Ok(())
		})
	}

	/// Apply `f` to the existing identity of `who` and stamp `updated_at`.
	fn mutate_existing(
		who: &T::AccountId,
		f: impl FnOnce(&mut Identity<BlockNumberFor<T>>) -> DispatchResult,
	) -> DispatchResult {
		let now = frame_system::Pallet::<T>::block_number();
		Identities::<T>::try_mutate(who, |slot| {
			let identity = slot.as_mut().ok_or(Error::<T>::NoIdentity)?;
			f(identity)?;
			identity.updated_at = now;
			Ok(())
		})
	}

	/// The field a key designates; links are not fields.
	pub(crate) fn slot(key: &FieldKey) -> Result<Slot, Error<T>> {
		match key {
			FieldKey::Typed(kind) => Ok(Slot::Typed(*kind)),
			FieldKey::Custom(custom) => {
				ensure!(validate::is_utf8(custom), Error::<T>::InvalidUtf8);
				Ok(Slot::Custom(custom.clone()))
			},
			FieldKey::Link(_) => Err(Error::<T>::LinkKeyNotSettable),
		}
	}

	/// A public value is a PGP fingerprint for [`FieldKind::Pgp`], UTF-8 text otherwise.
	pub(crate) fn check_public_value(slot: &Slot, value: &[u8]) -> Result<(), Error<T>> {
		match slot {
			Slot::Typed(FieldKind::Pgp) => {
				ensure!(validate::validate_pgp(value), Error::<T>::InvalidPgp)
			},
			_ => ensure!(validate::is_utf8(value), Error::<T>::InvalidUtf8),
		}
		Ok(())
	}

	fn check_link(title: &LinkTitle, url: &Value) -> Result<(), Error<T>> {
		ensure!(validate::is_utf8(title) && validate::is_utf8(url), Error::<T>::InvalidUtf8);
		Ok(())
	}

	fn write_slot(
		identity: &mut Identity<BlockNumberFor<T>>,
		slot: Slot,
		value: FieldValue,
	) -> DispatchResult {
		match slot {
			Slot::Typed(kind) => {
				// Unreachable: the bound is above the number of kinds.
				identity
					.typed
					.try_insert(kind, value)
					.map_err(|_| DispatchError::Other("typed field bound"))?;
			},
			Slot::Custom(custom) => {
				identity
					.custom
					.try_insert(custom, value)
					.map_err(|_| Error::<T>::TooManyCustomFields)?;
			},
		}
		Ok(())
	}
}
