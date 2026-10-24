//! Weights of the identitee pallet.
//!
//! Hand-written, without benchmarks: a fixed computation cost plus the database accesses of
//! each call, with the maximum encoded size of what it touches as proof size.

use crate::{
	limits::{
		MAX_ATTESTATIONS_PER_IDENTITY, MAX_AUTHORITIES, MAX_CUSTOM_FIELDS, MAX_FIELDS_PER_IDENTITY,
		MAX_FIELD_CHANGES, MAX_LINKS, MAX_PENDING_REQUESTS, MAX_SUBS, MAX_TYPED_FIELDS,
	},
	types::{
		AuthorityId, AuthorityInfo, Capabilities, Fact, FactKind, FieldAttestation, FieldKey,
		Identity, ImportedJudgements, Name, SecretBlob, SourceChain, SubLabel, Target,
	},
};
use codec::MaxEncodedLen;
use core::marker::PhantomData;
use frame_support::{
	traits::Get,
	weights::{RuntimeDbWeight, Weight},
	BoundedVec,
};
use frame_system::pallet_prelude::BlockNumberFor;

/// What clearing an identity deleted besides the identity itself: the input of
/// [`WeightInfo::clear_identity_actual`].
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cleared {
	/// Field attestations deleted.
	pub attestations: u32,
	/// Pending requests deleted.
	pub requests: u32,
	/// Facts about the person deleted (`kill_identity` only).
	pub facts: u32,
	/// Whether the identity had a name, now in quarantine.
	pub name: bool,
	/// Sub-account entries deleted: every sub the account listed, accepted link or pending
	/// proposal.
	pub subs: u32,
	/// Whether the migration history was looked up and deleted (`kill_identity` only,
	/// which does it whether there is one or not).
	pub history: bool,
	/// Whether the identity secret was deleted (`kill_identity` only, which does it
	/// whether there is one or not).
	pub secret: bool,
}

/// What `fulfil_migration` wrote besides the identity, its request and its history: the input
/// of [`WeightInfo::fulfil_migration_actual`].
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Imported {
	/// Field attestations written: one per imported field, or none.
	pub attestations: u32,
	/// Facts about the person written: at most one.
	pub facts: u32,
}

/// What `update_profile` did, or started before it failed: the input of
/// [`WeightInfo::update_profile_actual`].
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProfileWork {
	/// Whether it stored the identity secret.
	pub secret: bool,
	/// Whether it set the bio.
	pub bio: bool,
	/// Whether it set or cleared the avatar.
	pub avatar: bool,
	/// Field changes started, as counted by `set_identity` (at most [`MAX_FIELD_CHANGES`]).
	pub field_changes: u32,
	/// Whether it read the links to check the list it was given.
	pub links_read: bool,
	/// Links removed, updated and added, together. At most twice [`MAX_LINKS`]: every current
	/// link removed and a full list of new ones added.
	pub link_edits: u32,
	/// Whether it reordered the links.
	pub reorder: bool,
}

/// The most an `update_profile` can do: every step, a full `set_identity` and the most link
/// edits.
pub fn max_profile_work() -> ProfileWork {
	ProfileWork {
		secret: true,
		bio: true,
		avatar: true,
		field_changes: MAX_FIELD_CHANGES,
		links_read: true,
		link_edits: 2 * MAX_LINKS,
		reorder: true,
	}
}

/// Weight functions needed by the identitee pallet.
///
/// `claim_username`, `set_identity`, `update_profile`, `accept_sub`, `fulfil_migration` and the two
/// calls that clear an identity declare their worst case, which is large, and report what they
/// actually did after the fact with the `_actual` and `_early` functions. They are free for the
/// caller, so a declared weight that was never refunded would let anyone fill a block with calls
/// that do almost nothing.
pub trait WeightInfo {
	fn set_bio() -> Weight;
	fn set_field() -> Weight;
	fn clear_field() -> Weight;
	/// Worst case, declared by `set_identity`: [`MAX_FIELD_CHANGES`] changes, each as heavy as the
	/// heavier of a set and a clear.
	fn set_identity() -> Weight;
	/// Reported by `set_identity` from the number of changes it started (0 when it failed before
	/// the first, at most [`MAX_FIELD_CHANGES`]).
	fn set_identity_actual(changes: u32) -> Weight;
	/// Worst case, declared by `update_profile`: [`max_profile_work`].
	fn update_profile() -> Weight;
	/// Reported by `update_profile` from the steps it started (none when it failed before the
	/// first), each as heavy as its single call: the avatar as the heavier of a set and a clear,
	/// each link edit as the heaviest of an add, an update and a removal.
	fn update_profile_actual(work: ProfileWork) -> Weight;
	fn set_identity_secret() -> Weight;
	fn clear_identity_secret() -> Weight;
	fn add_link() -> Weight;
	fn update_link() -> Weight;
	fn remove_link() -> Weight;
	fn reorder_links() -> Weight;
	fn set_avatar() -> Weight;
	fn clear_avatar() -> Weight;
	fn reveal_field() -> Weight;
	/// Worst case, declared by `clear_identity` and `kill_identity`.
	fn clear_identity() -> Weight;
	/// Reported by a clearing call that fails: the account has no identity.
	fn clear_identity_early() -> Weight;
	/// Reported by a clearing call that succeeds, from what it deleted.
	fn clear_identity_actual(cleared: Cleared) -> Weight;
	fn add_authority() -> Weight;
	fn set_agent() -> Weight;
	fn remove_agent() -> Weight;
	fn set_authority_active() -> Weight;
	fn request_judgement() -> Weight;
	fn cancel_request() -> Weight;
	fn provide_judgement() -> Weight;
	fn revoke_attestation() -> Weight;
	fn reject_request() -> Weight;
	fn grant_fact() -> Weight;
	fn revoke_fact() -> Weight;
	/// Worst case, declared by `claim_username`.
	fn claim_username() -> Weight;
	/// Reported by a `claim_username` that fails before the identity is read: invalid name, the
	/// account has a name already or cannot claim yet.
	fn claim_username_early() -> Weight;
	/// Reported by a `claim_username` that read the identity: `scan_reads` storage reads looking
	/// for a verified field (every attestation of the fields examined, plus one read per field; at
	/// most [`max_scan_reads`]), `claimed` if it then wrote the name. A failure before the scan
	/// reports 0 reads.
	fn claim_username_actual(scan_reads: u32, claimed: bool) -> Weight;
	fn release_username() -> Weight;
	fn reserve_username() -> Weight;
	fn unreserve_username() -> Weight;
	fn set_username_for() -> Weight;
	fn unbind_username() -> Weight;
	fn add_sub() -> Weight;
	/// Worst case, declared by `accept_sub`: the caller's list of subs is full and has to be
	/// searched for an accepted one.
	fn accept_sub() -> Weight;
	/// Reported by `accept_sub`: `scan_reads` is the number of subs of the caller whose link it
	/// looked at (at most `MAX_SUBS`; 0 when it failed before the search). Not a function of the
	/// proposals made to the caller, which it does not touch.
	fn accept_sub_actual(scan_reads: u32) -> Weight;
	fn remove_sub() -> Weight;
	fn quit_sub() -> Weight;
	fn rename_sub() -> Weight;
	fn decline_sub() -> Weight;
	fn request_migration() -> Weight;
	fn cancel_migration() -> Weight;
	/// Worst case, declared by `fulfil_migration`: every field of the payload attested, and a
	/// fact.
	fn fulfil_migration() -> Weight;
	/// Reported by a `fulfil_migration` that succeeds, from what it wrote.
	fn fulfil_migration_actual(imported: Imported) -> Weight;
	fn reject_migration() -> Weight;
	/// Charged by the runtime's transaction extension on every user call: checking the quota
	/// (`Usage`, `BlockFeelessOps`) and recording its use.
	fn note_usage() -> Weight;
}

/// Fixed computation cost of a call.
const BASE_REF_TIME: u64 = 50_000_000;

/// Proof size of an `Identities` entry: the identity plus its key (hash + account id).
fn identity_proof_size<BlockNumber: MaxEncodedLen>() -> u64 {
	(Identity::<BlockNumber>::max_encoded_len() + 16 + 32) as u64
}

/// Proof size of the quota entries: a `Usage` entry with its key, and `BlockFeelessOps`.
fn quota_proof_size<BlockNumber: MaxEncodedLen>() -> u64 {
	(16 + 32 + <(BlockNumber, u32)>::max_encoded_len() + u32::max_encoded_len()) as u64
}

/// Proof size of an `Authorities` entry: the authority plus its key (hash + id).
fn authority_proof_size() -> u64 {
	(AuthorityInfo::max_encoded_len() + 16 + 4) as u64
}

/// Proof size of an `Agents` entry: the authority id and capabilities plus its key (hash +
/// account id).
fn agent_proof_size() -> u64 {
	(<(u32, Capabilities)>::max_encoded_len() + 16 + 32) as u64
}

/// Proof size of a `FieldAttestations` entry with its three keys.
fn attestation_proof_size<BlockNumber: MaxEncodedLen>() -> u64 {
	(FieldAttestation::<BlockNumber>::max_encoded_len()
		+ 16 + 32
		+ 16 + FieldKey::max_encoded_len()
		+ 16 + 4) as u64
}

/// Proof size of a `Facts` entry with its keys.
fn fact_proof_size<BlockNumber: MaxEncodedLen>() -> u64 {
	(Fact::<BlockNumber>::max_encoded_len() + 16 + 32 + 16 + FactKind::max_encoded_len() + 4) as u64
}

/// Proof size of a `PendingRequests` entry with its keys, and of the `PendingCount` entry.
fn request_proof_size<BlockNumber: MaxEncodedLen>() -> u64 {
	(BlockNumber::max_encoded_len() + 16 + 32 + 16 + 4 + Target::max_encoded_len()) as u64
		+ (16 + 32 + 4)
}

/// Proof size of the name entries a call can touch: `NameOf`, `NameOwner` and `Quarantine` with
/// their keys (`Reserved` weighs less than `Quarantine`).
fn name_proof_size<BlockNumber: MaxEncodedLen>() -> u64 {
	let name = Name::max_encoded_len();
	(16 + 32 + name + 16 + name + 32 + 16 + name + BlockNumber::max_encoded_len()) as u64
}

/// Proof size of a `SubOf` entry with its key (hash + account id): the parent and the label.
fn sub_link_proof_size() -> u64 {
	(<([u8; 32], SubLabel)>::max_encoded_len() + 16 + 32) as u64
}

/// Proof size of a `SubProposals` entry with its two keys (hash + account id each): the label.
fn sub_proposal_proof_size() -> u64 {
	(SubLabel::max_encoded_len() + 16 + 32 + 16 + 32) as u64
}

/// Proof size of a `SubsOf` entry with its key: the fullest list of sub-accounts.
fn subs_list_proof_size() -> u64 {
	(<BoundedVec<[u8; 32], crate::types::MaxSubs>>::max_encoded_len() + 16 + 32) as u64
}

/// Proof size of a `MigrationRequests` entry with its key: the source and the block.
fn migration_request_proof_size<BlockNumber: MaxEncodedLen>() -> u64 {
	(<(SourceChain, BlockNumber)>::max_encoded_len() + 16 + 32) as u64
}

/// Proof size of an `ImportedHistory` entry with its key: the fullest list of judgements.
fn history_proof_size() -> u64 {
	(<(SourceChain, u32, sp_core::H256, ImportedJudgements)>::max_encoded_len() + 16 + 32) as u64
}

/// Proof size of an `IdentitySecrets` entry with its key (hash + account id): the largest blob.
fn secret_proof_size() -> u64 {
	(SecretBlob::max_encoded_len() + 16 + 32) as u64
}

/// Proof size of the agent check: its `Agents` entry and its authority.
fn agent_check_proof_size() -> u64 {
	agent_proof_size() + authority_proof_size()
}

fn request_judgement_weight<BN: MaxEncodedLen>(db: RuntimeDbWeight) -> Weight {
	// Reads the identity, the authority, the request and the count; writes the last two.
	db.reads_writes(4, 2).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		identity_proof_size::<BN>() + authority_proof_size() + request_proof_size::<BN>(),
	))
}

fn cancel_request_weight<BN: MaxEncodedLen>(db: RuntimeDbWeight) -> Weight {
	db.reads_writes(2, 2)
		.saturating_add(Weight::from_parts(BASE_REF_TIME, request_proof_size::<BN>()))
}

fn provide_judgement_weight<BN: MaxEncodedLen>(db: RuntimeDbWeight) -> Weight {
	// Agent check (2), identity, request and count; writes the attestation, request and count.
	db.reads_writes(5, 3).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		agent_check_proof_size()
			+ identity_proof_size::<BN>()
			+ attestation_proof_size::<BN>()
			+ request_proof_size::<BN>(),
	))
}

fn revoke_attestation_weight<BN: MaxEncodedLen>(db: RuntimeDbWeight) -> Weight {
	db.reads_writes(3, 1).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		agent_check_proof_size() + attestation_proof_size::<BN>(),
	))
}

fn reject_request_weight<BN: MaxEncodedLen>(db: RuntimeDbWeight) -> Weight {
	db.reads_writes(4, 2).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		agent_check_proof_size() + request_proof_size::<BN>(),
	))
}

fn grant_fact_weight<BN: MaxEncodedLen>(db: RuntimeDbWeight) -> Weight {
	// Agent check (2), identity, request and count; writes the fact, request and count.
	db.reads_writes(5, 3).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		agent_check_proof_size()
			+ identity_proof_size::<BN>()
			+ fact_proof_size::<BN>()
			+ request_proof_size::<BN>(),
	))
}

fn revoke_fact_weight<BN: MaxEncodedLen>(db: RuntimeDbWeight) -> Weight {
	db.reads_writes(3, 1).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		agent_check_proof_size() + fact_proof_size::<BN>(),
	))
}

/// Storage reads of the search for a verified field in an identity at its fullest: every
/// attestation of every field, and one more read per field to find the end of its attestations.
pub fn max_scan_reads() -> u32 {
	MAX_FIELDS_PER_IDENTITY + MAX_ATTESTATIONS_PER_IDENTITY
}

/// A `claim_username` that fails before it reads the identity: reads the name of the caller and its
/// last release.
fn claim_username_early_weight<BN: MaxEncodedLen>(db: RuntimeDbWeight) -> Weight {
	db.reads(2)
		.saturating_add(Weight::from_parts(BASE_REF_TIME, name_proof_size::<BN>()))
}

/// A `claim_username` past the early checks: reads the name of the caller, its last release, its
/// identity, the owner, the reservation and the quarantine of the name, the fraud check (the
/// authority id counter and one `Fraud` fact per authority, counted at its most), then
/// `scan_reads` attestation entries. If it claims, it writes the quarantine (deleted when it has
/// ended), the owner, the name, and deletes the last release.
fn claim_username_weight<BN: MaxEncodedLen>(
	db: RuntimeDbWeight,
	scan_reads: u64,
	claimed: bool,
) -> Weight {
	let writes = if claimed { 4 } else { 0 };
	let fraud_reads = 1 + u64::from(MAX_AUTHORITIES);
	db.reads_writes(6 + fraud_reads + scan_reads, writes)
		.saturating_add(Weight::from_parts(
			BASE_REF_TIME,
			identity_proof_size::<BN>()
				+ name_proof_size::<BN>()
				+ next_authority_id_proof_size()
				+ u64::from(MAX_AUTHORITIES) * fact_proof_size::<BN>()
				+ scan_reads * attestation_proof_size::<BN>(),
		))
}

/// Proof size of the `NextAuthorityId` value with its key.
fn next_authority_id_proof_size() -> u64 {
	(AuthorityId::max_encoded_len() + 32) as u64
}

/// One read and one write of an `IdentitySecrets` entry, for setting or deleting it.
fn identity_secret_weight(db: RuntimeDbWeight) -> Weight {
	db.reads_writes(1, 1)
		.saturating_add(Weight::from_parts(BASE_REF_TIME, secret_proof_size()))
}

fn release_username_weight<BN: MaxEncodedLen>(db: RuntimeDbWeight) -> Weight {
	// Takes the name of the caller; removes the owner, writes the quarantine and the release.
	db.reads_writes(1, 4)
		.saturating_add(Weight::from_parts(BASE_REF_TIME, name_proof_size::<BN>()))
}

fn reserve_username_weight<BN: MaxEncodedLen>(db: RuntimeDbWeight) -> Weight {
	// Agent check (2), owner and reservation; writes the reservation.
	db.reads_writes(4, 1).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		agent_check_proof_size() + name_proof_size::<BN>(),
	))
}

fn unreserve_username_weight<BN: MaxEncodedLen>(db: RuntimeDbWeight) -> Weight {
	// Agent check (2); takes the reservation.
	db.reads_writes(3, 1).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		agent_check_proof_size() + name_proof_size::<BN>(),
	))
}

fn set_username_for_weight<BN: MaxEncodedLen>(db: RuntimeDbWeight) -> Weight {
	// Agent check (2), identity, name of the target, owner and quarantine; writes the
	// reservation, the quarantine, the owner and the name.
	db.reads_writes(6, 4).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		agent_check_proof_size() + identity_proof_size::<BN>() + name_proof_size::<BN>(),
	))
}

fn unbind_username_weight<BN: MaxEncodedLen>(db: RuntimeDbWeight) -> Weight {
	// Agent check (2) and the name of the target; removes the owner, writes the quarantine.
	db.reads_writes(3, 3).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		agent_check_proof_size() + name_proof_size::<BN>(),
	))
}

fn add_sub_weight<BN: MaxEncodedLen>(db: RuntimeDbWeight) -> Weight {
	// Reads the identity of the parent, its own link and its list of subs; writes the proposal
	// and the list.
	db.reads_writes(3, 2).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		identity_proof_size::<BN>()
			+ sub_link_proof_size()
			+ subs_list_proof_size()
			+ sub_proposal_proof_size(),
	))
}

/// An `accept_sub` that looked at `scan_reads` links: reads the proposal, the link of the caller,
/// the link of the parent and the list of the caller, then the link of each of its subs while it
/// searches for an accepted one; writes the link and deletes the proposal.
fn accept_sub_weight(db: RuntimeDbWeight, scan_reads: u64) -> Weight {
	db.reads_writes(4 + scan_reads, 2).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		sub_proposal_proof_size()
			+ 2 * sub_link_proof_size()
			+ subs_list_proof_size()
			+ scan_reads * sub_link_proof_size(),
	))
}

fn remove_sub_weight(db: RuntimeDbWeight) -> Weight {
	// Reads the link, the proposal and the list of the parent; deletes one of the first two and
	// takes the sub off the list.
	db.reads_writes(3, 2).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		sub_link_proof_size() + sub_proposal_proof_size() + subs_list_proof_size(),
	))
}

fn quit_sub_weight(db: RuntimeDbWeight) -> Weight {
	db.reads_writes(2, 2).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		sub_link_proof_size() + subs_list_proof_size(),
	))
}

fn decline_sub_weight(db: RuntimeDbWeight) -> Weight {
	db.reads_writes(2, 2).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		sub_proposal_proof_size() + subs_list_proof_size(),
	))
}

fn rename_sub_weight(db: RuntimeDbWeight) -> Weight {
	// Reads the link, then the proposal; writes one of them.
	db.reads_writes(2, 1).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		sub_link_proof_size() + sub_proposal_proof_size(),
	))
}

fn request_migration_weight<BN: MaxEncodedLen>(db: RuntimeDbWeight) -> Weight {
	// Reads the identity, the request and the history; writes the request.
	db.reads_writes(3, 1).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		identity_proof_size::<BN>() + migration_request_proof_size::<BN>() + history_proof_size(),
	))
}

fn cancel_migration_weight<BN: MaxEncodedLen>(db: RuntimeDbWeight) -> Weight {
	db.reads_writes(1, 1)
		.saturating_add(Weight::from_parts(BASE_REF_TIME, migration_request_proof_size::<BN>()))
}

fn reject_migration_weight<BN: MaxEncodedLen>(db: RuntimeDbWeight) -> Weight {
	// Agent check (2) and the request; deletes the request.
	db.reads_writes(3, 1).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		agent_check_proof_size() + migration_request_proof_size::<BN>(),
	))
}

/// A `fulfil_migration` that wrote `imported`: reads the agent check (2), the request, the
/// identity and the authority's fact of the derived kind (a judgement derives one at most,
/// counted whether or not it did); deletes the request, writes the identity, the history, the
/// attestations and the facts.
fn fulfil_migration_weight<BN: MaxEncodedLen>(db: RuntimeDbWeight, imported: Imported) -> Weight {
	let attestations = u64::from(imported.attestations);
	let facts = u64::from(imported.facts);
	db.reads_writes(5, 3 + attestations + facts).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		agent_check_proof_size()
			+ migration_request_proof_size::<BN>()
			+ identity_proof_size::<BN>()
			+ history_proof_size()
			+ (1 + facts) * fact_proof_size::<BN>()
			+ attestations * attestation_proof_size::<BN>(),
	))
}

/// The most a `fulfil_migration` can write: every field a payload can hold attested, and the
/// facts (a judgement maps to one at most; bounded by the number of kinds).
fn max_imported() -> Imported {
	Imported { attestations: MAX_TYPED_FIELDS + MAX_CUSTOM_FIELDS, facts: FactKind::COUNT }
}

/// The identity write, plus touching the attestations of one field, at most one per
/// authority: `reveal_field` rewrites them, `clear_field` and `remove_link` delete them.
fn field_with_attestations_weight<BN: MaxEncodedLen>(db: RuntimeDbWeight) -> Weight {
	let a = u64::from(MAX_AUTHORITIES);
	db.reads_writes(1 + a, 1 + a).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		identity_proof_size::<BN>() + a * attestation_proof_size::<BN>(),
	))
}

/// A clearing call that finds no identity: one read of the `Identities` key.
fn clear_identity_early_weight(db: RuntimeDbWeight) -> Weight {
	db.reads(1).saturating_add(Weight::from_parts(BASE_REF_TIME, 16 + 32))
}

/// The identity removal, plus what `cleared` says was deleted with it: attestations, requests,
/// facts (`kill_identity` only), the pending count, the name entries (name, owner,
/// quarantine) when the identity had a name, the list of sub-accounts with their links and
/// proposals, the migration history and the identity secret (the last two for
/// `kill_identity` only).
fn clear_identity_weight<BN: MaxEncodedLen>(db: RuntimeDbWeight, cleared: Cleared) -> Weight {
	let attestations = u64::from(cleared.attestations);
	let facts = u64::from(cleared.facts);
	let requests = u64::from(cleared.requests);
	let name_entries = if cleared.name { 3 } else { 0 };
	let subs = u64::from(cleared.subs);
	let history = if cleared.history { 1 } else { 0 };
	let secret = if cleared.secret { 1 } else { 0 };
	// The identity, every entry, the pending count, the list of sub-accounts (looked up even
	// when empty) with the link of each, the migration history and the identity secret.
	let entries =
		1 + attestations + facts + requests + 1 + name_entries + 1 + subs + history + secret;
	let name_proof = if cleared.name { name_proof_size::<BN>() } else { 0 };
	let subs_proof = if cleared.subs > 0 {
		subs_list_proof_size() + subs * (sub_link_proof_size() + sub_proposal_proof_size())
	} else {
		0
	};
	db.reads_writes(entries, entries).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		identity_proof_size::<BN>()
			+ attestations * attestation_proof_size::<BN>()
			+ facts * fact_proof_size::<BN>()
			+ requests * request_proof_size::<BN>()
			+ name_proof
			+ subs_proof
			+ history * history_proof_size()
			+ secret * secret_proof_size(),
	))
}

/// The most a clearing call can delete: `kill_identity` of a full identity with a name.
/// (`clear_identity` leaves the facts, so it is bounded by this too.)
fn max_cleared() -> Cleared {
	Cleared {
		attestations: MAX_ATTESTATIONS_PER_IDENTITY,
		requests: MAX_PENDING_REQUESTS,
		facts: FactKind::COUNT * MAX_AUTHORITIES,
		name: true,
		subs: MAX_SUBS,
		history: true,
		secret: true,
	}
}

/// `changes` changes of `set_identity`, each as heavy as the heavier of a set and a clear.
fn set_identity_weight(set_field: Weight, clear_field: Weight, changes: u32) -> Weight {
	set_field.max(clear_field).saturating_mul(u64::from(changes))
}

/// `work` priced with the weights of the single calls `W` gives; `links_read` is the price of
/// reading the identity to check a link list.
fn update_profile_weight<W: WeightInfo + ?Sized>(work: ProfileWork, links_read: Weight) -> Weight {
	let when = |done: bool, weight: Weight| if done { weight } else { Weight::zero() };
	let link_edit = W::add_link().max(W::update_link()).max(W::remove_link());
	when(work.secret, W::set_identity_secret())
		.saturating_add(when(work.bio, W::set_bio()))
		.saturating_add(when(work.avatar, W::set_avatar().max(W::clear_avatar())))
		.saturating_add(W::set_identity_actual(work.field_changes))
		.saturating_add(when(work.links_read, links_read))
		.saturating_add(link_edit.saturating_mul(u64::from(work.link_edits)))
		.saturating_add(when(work.reorder, W::reorder_links()))
}

/// No database weights, for the unit implementation.
const NO_DB: RuntimeDbWeight = RuntimeDbWeight { read: 0, write: 0 };

/// Weights for the identitee pallet, from the runtime's database weights.
pub struct SubstrateWeight<T>(PhantomData<T>);

impl<T: crate::Config> WeightInfo for SubstrateWeight<T> {
	fn set_bio() -> Weight {
		identity_write::<T>()
	}
	fn set_field() -> Weight {
		identity_write::<T>()
	}
	fn clear_field() -> Weight {
		field_with_attestations_weight::<BlockNumberFor<T>>(T::DbWeight::get())
	}
	fn set_identity() -> Weight {
		Self::set_identity_actual(MAX_FIELD_CHANGES)
	}
	fn set_identity_actual(changes: u32) -> Weight {
		set_identity_weight(Self::set_field(), Self::clear_field(), changes)
	}
	fn update_profile() -> Weight {
		Self::update_profile_actual(max_profile_work())
	}
	fn update_profile_actual(work: ProfileWork) -> Weight {
		let read = T::DbWeight::get()
			.reads(1)
			.saturating_add(Weight::from_parts(0, identity_proof_size::<BlockNumberFor<T>>()));
		update_profile_weight::<Self>(work, read)
	}
	fn set_identity_secret() -> Weight {
		identity_secret_weight(T::DbWeight::get())
	}
	fn clear_identity_secret() -> Weight {
		identity_secret_weight(T::DbWeight::get())
	}
	fn add_link() -> Weight {
		identity_write::<T>()
	}
	fn update_link() -> Weight {
		identity_write::<T>()
	}
	fn remove_link() -> Weight {
		field_with_attestations_weight::<BlockNumberFor<T>>(T::DbWeight::get())
	}
	fn reorder_links() -> Weight {
		identity_write::<T>()
	}
	fn set_avatar() -> Weight {
		identity_write::<T>()
	}
	fn clear_avatar() -> Weight {
		identity_write::<T>()
	}
	fn reveal_field() -> Weight {
		field_with_attestations_weight::<BlockNumberFor<T>>(T::DbWeight::get())
	}
	fn clear_identity() -> Weight {
		clear_identity_weight::<BlockNumberFor<T>>(T::DbWeight::get(), max_cleared())
	}
	fn clear_identity_early() -> Weight {
		clear_identity_early_weight(T::DbWeight::get())
	}
	fn clear_identity_actual(cleared: Cleared) -> Weight {
		clear_identity_weight::<BlockNumberFor<T>>(T::DbWeight::get(), cleared)
	}
	fn add_authority() -> Weight {
		// Reads `NextAuthorityId`, writes it and the new `Authorities` entry.
		T::DbWeight::get().reads_writes(1, 2).saturating_add(Weight::from_parts(
			BASE_REF_TIME,
			authority_proof_size() + u32::max_encoded_len() as u64,
		))
	}
	fn set_agent() -> Weight {
		// Reads the authority and the agent's current entry, writes the entry.
		T::DbWeight::get().reads_writes(2, 1).saturating_add(Weight::from_parts(
			BASE_REF_TIME,
			authority_proof_size() + agent_proof_size(),
		))
	}
	fn remove_agent() -> Weight {
		T::DbWeight::get()
			.reads_writes(1, 1)
			.saturating_add(Weight::from_parts(BASE_REF_TIME, agent_proof_size()))
	}
	fn set_authority_active() -> Weight {
		T::DbWeight::get()
			.reads_writes(1, 1)
			.saturating_add(Weight::from_parts(BASE_REF_TIME, authority_proof_size()))
	}
	fn request_judgement() -> Weight {
		request_judgement_weight::<BlockNumberFor<T>>(T::DbWeight::get())
	}
	fn cancel_request() -> Weight {
		cancel_request_weight::<BlockNumberFor<T>>(T::DbWeight::get())
	}
	fn provide_judgement() -> Weight {
		provide_judgement_weight::<BlockNumberFor<T>>(T::DbWeight::get())
	}
	fn revoke_attestation() -> Weight {
		revoke_attestation_weight::<BlockNumberFor<T>>(T::DbWeight::get())
	}
	fn reject_request() -> Weight {
		reject_request_weight::<BlockNumberFor<T>>(T::DbWeight::get())
	}
	fn grant_fact() -> Weight {
		grant_fact_weight::<BlockNumberFor<T>>(T::DbWeight::get())
	}
	fn revoke_fact() -> Weight {
		revoke_fact_weight::<BlockNumberFor<T>>(T::DbWeight::get())
	}
	fn claim_username() -> Weight {
		claim_username_weight::<BlockNumberFor<T>>(
			T::DbWeight::get(),
			u64::from(max_scan_reads()),
			true,
		)
	}
	fn claim_username_early() -> Weight {
		claim_username_early_weight::<BlockNumberFor<T>>(T::DbWeight::get())
	}
	fn claim_username_actual(scan_reads: u32, claimed: bool) -> Weight {
		claim_username_weight::<BlockNumberFor<T>>(
			T::DbWeight::get(),
			u64::from(scan_reads),
			claimed,
		)
	}
	fn release_username() -> Weight {
		release_username_weight::<BlockNumberFor<T>>(T::DbWeight::get())
	}
	fn reserve_username() -> Weight {
		reserve_username_weight::<BlockNumberFor<T>>(T::DbWeight::get())
	}
	fn unreserve_username() -> Weight {
		unreserve_username_weight::<BlockNumberFor<T>>(T::DbWeight::get())
	}
	fn set_username_for() -> Weight {
		set_username_for_weight::<BlockNumberFor<T>>(T::DbWeight::get())
	}
	fn unbind_username() -> Weight {
		unbind_username_weight::<BlockNumberFor<T>>(T::DbWeight::get())
	}
	fn add_sub() -> Weight {
		add_sub_weight::<BlockNumberFor<T>>(T::DbWeight::get())
	}
	fn accept_sub() -> Weight {
		accept_sub_weight(T::DbWeight::get(), u64::from(MAX_SUBS))
	}
	fn accept_sub_actual(scan_reads: u32) -> Weight {
		accept_sub_weight(T::DbWeight::get(), u64::from(scan_reads))
	}
	fn remove_sub() -> Weight {
		remove_sub_weight(T::DbWeight::get())
	}
	fn quit_sub() -> Weight {
		quit_sub_weight(T::DbWeight::get())
	}
	fn rename_sub() -> Weight {
		rename_sub_weight(T::DbWeight::get())
	}
	fn decline_sub() -> Weight {
		decline_sub_weight(T::DbWeight::get())
	}
	fn request_migration() -> Weight {
		request_migration_weight::<BlockNumberFor<T>>(T::DbWeight::get())
	}
	fn cancel_migration() -> Weight {
		cancel_migration_weight::<BlockNumberFor<T>>(T::DbWeight::get())
	}
	fn fulfil_migration() -> Weight {
		fulfil_migration_weight::<BlockNumberFor<T>>(T::DbWeight::get(), max_imported())
	}
	fn fulfil_migration_actual(imported: Imported) -> Weight {
		fulfil_migration_weight::<BlockNumberFor<T>>(T::DbWeight::get(), imported)
	}
	fn reject_migration() -> Weight {
		reject_migration_weight::<BlockNumberFor<T>>(T::DbWeight::get())
	}
	fn note_usage() -> Weight {
		T::DbWeight::get()
			.reads_writes(2, 2)
			.saturating_add(Weight::from_parts(0, quota_proof_size::<BlockNumberFor<T>>()))
	}
}

/// One read and one write of an `Identities` entry.
fn identity_write<T: crate::Config>() -> Weight {
	T::DbWeight::get().reads_writes(1, 1).saturating_add(Weight::from_parts(
		BASE_REF_TIME,
		identity_proof_size::<BlockNumberFor<T>>(),
	))
}

/// Unit implementation for tests: same formula, without database weights.
impl WeightInfo for () {
	fn set_bio() -> Weight {
		Weight::from_parts(BASE_REF_TIME, identity_proof_size::<u32>())
	}
	fn set_field() -> Weight {
		Weight::from_parts(BASE_REF_TIME, identity_proof_size::<u32>())
	}
	fn clear_field() -> Weight {
		field_with_attestations_weight::<u32>(NO_DB)
	}
	fn set_identity() -> Weight {
		Self::set_identity_actual(MAX_FIELD_CHANGES)
	}
	fn set_identity_actual(changes: u32) -> Weight {
		set_identity_weight(Self::set_field(), Self::clear_field(), changes)
	}
	fn update_profile() -> Weight {
		Self::update_profile_actual(max_profile_work())
	}
	fn update_profile_actual(work: ProfileWork) -> Weight {
		update_profile_weight::<Self>(work, Weight::from_parts(0, identity_proof_size::<u32>()))
	}
	fn set_identity_secret() -> Weight {
		identity_secret_weight(NO_DB)
	}
	fn clear_identity_secret() -> Weight {
		identity_secret_weight(NO_DB)
	}
	fn add_link() -> Weight {
		Weight::from_parts(BASE_REF_TIME, identity_proof_size::<u32>())
	}
	fn update_link() -> Weight {
		Weight::from_parts(BASE_REF_TIME, identity_proof_size::<u32>())
	}
	fn remove_link() -> Weight {
		field_with_attestations_weight::<u32>(NO_DB)
	}
	fn reorder_links() -> Weight {
		Weight::from_parts(BASE_REF_TIME, identity_proof_size::<u32>())
	}
	fn set_avatar() -> Weight {
		Weight::from_parts(BASE_REF_TIME, identity_proof_size::<u32>())
	}
	fn clear_avatar() -> Weight {
		Weight::from_parts(BASE_REF_TIME, identity_proof_size::<u32>())
	}
	fn reveal_field() -> Weight {
		field_with_attestations_weight::<u32>(NO_DB)
	}
	fn clear_identity() -> Weight {
		clear_identity_weight::<u32>(NO_DB, max_cleared())
	}
	fn clear_identity_early() -> Weight {
		clear_identity_early_weight(NO_DB)
	}
	fn clear_identity_actual(cleared: Cleared) -> Weight {
		clear_identity_weight::<u32>(NO_DB, cleared)
	}
	fn add_authority() -> Weight {
		Weight::from_parts(BASE_REF_TIME, authority_proof_size() + u32::max_encoded_len() as u64)
	}
	fn set_agent() -> Weight {
		Weight::from_parts(BASE_REF_TIME, authority_proof_size() + agent_proof_size())
	}
	fn remove_agent() -> Weight {
		Weight::from_parts(BASE_REF_TIME, agent_proof_size())
	}
	fn set_authority_active() -> Weight {
		Weight::from_parts(BASE_REF_TIME, authority_proof_size())
	}
	fn request_judgement() -> Weight {
		request_judgement_weight::<u32>(NO_DB)
	}
	fn cancel_request() -> Weight {
		cancel_request_weight::<u32>(NO_DB)
	}
	fn provide_judgement() -> Weight {
		provide_judgement_weight::<u32>(NO_DB)
	}
	fn revoke_attestation() -> Weight {
		revoke_attestation_weight::<u32>(NO_DB)
	}
	fn reject_request() -> Weight {
		reject_request_weight::<u32>(NO_DB)
	}
	fn grant_fact() -> Weight {
		grant_fact_weight::<u32>(NO_DB)
	}
	fn revoke_fact() -> Weight {
		revoke_fact_weight::<u32>(NO_DB)
	}
	fn claim_username() -> Weight {
		claim_username_weight::<u32>(NO_DB, u64::from(max_scan_reads()), true)
	}
	fn claim_username_early() -> Weight {
		claim_username_early_weight::<u32>(NO_DB)
	}
	fn claim_username_actual(scan_reads: u32, claimed: bool) -> Weight {
		claim_username_weight::<u32>(NO_DB, u64::from(scan_reads), claimed)
	}
	fn release_username() -> Weight {
		release_username_weight::<u32>(NO_DB)
	}
	fn reserve_username() -> Weight {
		reserve_username_weight::<u32>(NO_DB)
	}
	fn unreserve_username() -> Weight {
		unreserve_username_weight::<u32>(NO_DB)
	}
	fn set_username_for() -> Weight {
		set_username_for_weight::<u32>(NO_DB)
	}
	fn unbind_username() -> Weight {
		unbind_username_weight::<u32>(NO_DB)
	}
	fn add_sub() -> Weight {
		add_sub_weight::<u32>(NO_DB)
	}
	fn accept_sub() -> Weight {
		accept_sub_weight(NO_DB, u64::from(MAX_SUBS))
	}
	fn accept_sub_actual(scan_reads: u32) -> Weight {
		accept_sub_weight(NO_DB, u64::from(scan_reads))
	}
	fn remove_sub() -> Weight {
		remove_sub_weight(NO_DB)
	}
	fn quit_sub() -> Weight {
		quit_sub_weight(NO_DB)
	}
	fn rename_sub() -> Weight {
		rename_sub_weight(NO_DB)
	}
	fn decline_sub() -> Weight {
		decline_sub_weight(NO_DB)
	}
	fn request_migration() -> Weight {
		request_migration_weight::<u32>(NO_DB)
	}
	fn cancel_migration() -> Weight {
		cancel_migration_weight::<u32>(NO_DB)
	}
	fn fulfil_migration() -> Weight {
		fulfil_migration_weight::<u32>(NO_DB, max_imported())
	}
	fn fulfil_migration_actual(imported: Imported) -> Weight {
		fulfil_migration_weight::<u32>(NO_DB, imported)
	}
	fn reject_migration() -> Weight {
		reject_migration_weight::<u32>(NO_DB)
	}
	fn note_usage() -> Weight {
		Weight::from_parts(0, quota_proof_size::<u32>())
	}
}
