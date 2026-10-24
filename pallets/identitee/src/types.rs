//! Data types stored by the identitee pallet.

use crate::limits::{
	MAX_AUTHORITY_NAME_LEN, MAX_AVATAR_LEN, MAX_BIO_LEN, MAX_CUSTOM_FIELDS, MAX_CUSTOM_KEY_LEN,
	MAX_FIELD_CHANGES, MAX_IMPORTED_JUDGEMENTS, MAX_LINKS, MAX_LINK_TITLE_LEN, MAX_NOTE_LEN,
	MAX_SECRET_BLOB_LEN, MAX_SUBS, MAX_SUB_LABEL_LEN, MAX_TYPED_FIELDS, MAX_VALUE_LEN, NAME_MAX,
};
use codec::{Decode, DecodeWithMemTracking, Encode, MaxEncodedLen};
use frame_support::{traits::ConstU32, BoundedBTreeMap, BoundedVec};
use scale_info::TypeInfo;
use sp_core::H256;

/// Bound of a field value or link url, in bytes.
pub type MaxValueLen = ConstU32<MAX_VALUE_LEN>;
/// Bound of a custom field key, in bytes.
pub type MaxCustomKeyLen = ConstU32<MAX_CUSTOM_KEY_LEN>;
/// Bound of the number of custom fields.
pub type MaxCustomFields = ConstU32<MAX_CUSTOM_FIELDS>;
/// Bound of the number of links.
pub type MaxLinks = ConstU32<MAX_LINKS>;
/// Bound of a link title, in bytes.
pub type MaxLinkTitleLen = ConstU32<MAX_LINK_TITLE_LEN>;
/// Bound of the bio, in UTF-8 bytes.
pub type MaxBioLen = ConstU32<MAX_BIO_LEN>;
/// Bound of the avatar image, in bytes.
pub type MaxAvatarLen = ConstU32<MAX_AVATAR_LEN>;
/// Bound of an authority name, in bytes.
pub type MaxAuthorityNameLen = ConstU32<MAX_AUTHORITY_NAME_LEN>;
/// Bound of a note attached to a fact or a refusal, in bytes.
pub type MaxNoteLen = ConstU32<MAX_NOTE_LEN>;
/// Bound of the number of typed fields (above the number of [`FieldKind`] variants).
pub type MaxTypedFields = ConstU32<MAX_TYPED_FIELDS>;
/// Bound of a native name, in bytes.
pub type MaxNameLen = ConstU32<NAME_MAX>;
/// Bound of the number of sub-accounts of an account.
pub type MaxSubs = ConstU32<MAX_SUBS>;
/// Bound of a sub-account label, in bytes.
pub type MaxSubLabelLen = ConstU32<MAX_SUB_LABEL_LEN>;
/// Bound of the number of registrar judgements a migration imports.
pub type MaxImportedJudgements = ConstU32<MAX_IMPORTED_JUDGEMENTS>;
/// Bound of the number of changes of one `set_identity` call.
pub type MaxFieldChanges = ConstU32<MAX_FIELD_CHANGES>;
/// Bound of the encrypted identity secret, in bytes.
pub type MaxSecretBlobLen = ConstU32<MAX_SECRET_BLOB_LEN>;

/// Bio text: valid UTF-8, at most [`MAX_BIO_LEN`] bytes.
pub type Bio = BoundedVec<u8, MaxBioLen>;
/// A field value or a link url.
pub type Value = BoundedVec<u8, MaxValueLen>;
/// A custom field key: valid UTF-8.
pub type CustomKey = BoundedVec<u8, MaxCustomKeyLen>;
/// A link title: valid UTF-8.
pub type LinkTitle = BoundedVec<u8, MaxLinkTitleLen>;
/// A list of link ids, as given to `reorder_links`.
pub type LinkIds = BoundedVec<u32, MaxLinks>;
/// An avatar image (WebP, see [`crate::validate::validate_avatar`]).
pub type AvatarBytes = BoundedVec<u8, MaxAvatarLen>;
/// The encrypted identity secret of an account: opaque bytes produced by the client (the chain
/// never reads them), at most [`MAX_SECRET_BLOB_LEN`].
pub type SecretBlob = BoundedVec<u8, MaxSecretBlobLen>;
/// The name of an identity authority: valid UTF-8.
pub type AuthorityName = BoundedVec<u8, MaxAuthorityNameLen>;

/// A short note attached to a fact or a refusal: valid UTF-8.
pub type Note = BoundedVec<u8, MaxNoteLen>;

/// A native name: [`crate::limits::NAME_MIN`] to [`NAME_MAX`] bytes of `a-z`, `0-9`, `-` and
/// `_` (see [`crate::validate::validate_name`]). The type only bounds the length: the alphabet
/// and the minimum are checked by the calls.
pub type Name = BoundedVec<u8, MaxNameLen>;

/// The label a parent gives to a sub-account ("work laptop"): valid UTF-8, at most
/// [`MAX_SUB_LABEL_LEN`] bytes.
pub type SubLabel = BoundedVec<u8, MaxSubLabelLen>;

/// Identifier of an identity authority, assigned sequentially from 0 at registration.
pub type AuthorityId = u32;

/// The kinds of typed fields an identity can carry.
#[derive(
	Encode,
	Decode,
	DecodeWithMemTracking,
	Clone,
	Copy,
	PartialEq,
	Eq,
	PartialOrd,
	Ord,
	Debug,
	TypeInfo,
	MaxEncodedLen,
)]
pub enum FieldKind {
	DisplayName,
	LegalName,
	Web,
	Email,
	Matrix,
	X,
	Discord,
	GitHub,
	Telegram,
	/// PGP fingerprint: raw bytes, 20 (v4) or 32 (v6), never text.
	Pgp,
}

impl FieldKind {
	/// Whether an authority can attest control of this field. Names are declarative only.
	pub fn is_verifiable(&self) -> bool {
		!matches!(self, FieldKind::DisplayName | FieldKind::LegalName)
	}
}

/// The value of a field: in clear, or as a commitment kept private until revealed.
#[derive(
	Encode, Decode, DecodeWithMemTracking, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen,
)]
pub enum FieldValue {
	/// Value in clear.
	Public(Value),
	/// [`private_commitment`] of a salt and the value, revealed later with `reveal_field`.
	Private(H256),
}

/// Domain tag of the commitment of a public value: `blake2_256(tag ‖ value)`.
///
/// Each kind of commitment has its own tag, so that no public value, private commitment or
/// link can be made to share the commitment of another kind and inherit its attestations.
pub const PUBLIC_COMMITMENT_TAG: &[u8] = b"identitee:field:public:v1";
/// Domain tag of a private commitment: `blake2_256(tag ‖ salt ‖ value)`, computed by the
/// client with a 32-byte salt and checked by `reveal_field`.
pub const PRIVATE_COMMITMENT_TAG: &[u8] = b"identitee:field:private:v1";
/// Domain tag of the commitment of a link: `blake2_256(tag ‖ SCALE((title, url)))`.
pub const LINK_COMMITMENT_TAG: &[u8] = b"identitee:field:link:v1";

fn tagged_hash(tag: &[u8], parts: &[&[u8]]) -> H256 {
	let mut preimage = tag.to_vec();
	for part in parts {
		preimage.extend_from_slice(part);
	}
	H256(sp_io::hashing::blake2_256(&preimage))
}

/// The commitment of a field value, the same whether it is public or still private: the
/// tagged hash of a public value ([`PUBLIC_COMMITMENT_TAG`]), the private commitment as is.
pub fn commitment(value: &FieldValue) -> H256 {
	match value {
		FieldValue::Public(v) => tagged_hash(PUBLIC_COMMITMENT_TAG, &[v]),
		FieldValue::Private(h) => *h,
	}
}

/// The private commitment of `value` under `salt` ([`PRIVATE_COMMITMENT_TAG`]).
pub fn private_commitment(salt: &[u8; 32], value: &[u8]) -> H256 {
	tagged_hash(PRIVATE_COMMITMENT_TAG, &[salt, value])
}

/// The commitment of a link ([`LINK_COMMITMENT_TAG`]): changing its title or url changes it.
pub fn link_commitment(title: &LinkTitle, url: &Value) -> H256 {
	tagged_hash(LINK_COMMITMENT_TAG, &[&(title, url).encode()])
}

/// What a field event, an attestation or a request points at in an identity.
#[derive(
	Encode, Decode, DecodeWithMemTracking, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen,
)]
pub enum FieldKey {
	/// A typed field.
	Typed(FieldKind),
	/// A custom field, by key.
	Custom(CustomKey),
	/// A link, by stable id. Not settable with `set_field`: links have their own calls.
	Link(u32),
}

/// The changes of one `set_identity` call, applied in order: a value sets the field like
/// `set_field`, `None` clears it like `clear_field`.
pub type FieldChanges = BoundedVec<(FieldKey, Option<FieldValue>), MaxFieldChanges>;

/// One entry of the link list of an `update_profile` call.
#[derive(
	Encode, Decode, DecodeWithMemTracking, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen,
)]
pub enum LinkEdit {
	/// An existing link, unchanged.
	Keep(u32),
	/// An existing link with a new title and url (as `update_link`).
	Update { id: u32, title: LinkTitle, url: Value },
	/// A new link (as `add_link`; it gets the next link id).
	Add { title: LinkTitle, url: Value },
}

/// The profile changes of one `update_profile` call. `None` keeps a part as it is.
#[derive(
	Encode,
	Decode,
	DecodeWithMemTracking,
	Clone,
	PartialEq,
	Eq,
	Default,
	Debug,
	TypeInfo,
	MaxEncodedLen,
)]
pub struct ProfileUpdate {
	/// `None`: keep the bio. `Some(bio)`: set it (empty bytes = an empty bio, as `set_bio` does).
	pub bio: Option<Bio>,
	/// `None`: keep. `Some(None)`: remove the avatar. `Some(Some(bytes))`: set it.
	pub avatar: Option<Option<AvatarBytes>>,
	/// Field changes, exactly the `set_identity` argument (may be empty).
	pub fields: FieldChanges,
	/// `None`: keep the links as they are. `Some(list)`: the links become exactly `list`, in its
	/// order.
	pub links: Option<BoundedVec<LinkEdit, MaxLinks>>,
	/// `Some(blob)`: store the identity secret (as `set_identity_secret`). `None`: keep.
	pub secret: Option<SecretBlob>,
}

/// A link of an identity.
#[derive(
	Encode, Decode, DecodeWithMemTracking, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen,
)]
pub struct Link {
	/// Stable id, never reused within an identity.
	pub id: u32,
	/// Title, valid UTF-8.
	pub title: LinkTitle,
	/// Url, valid UTF-8.
	pub url: Value,
}

/// An on-chain identity profile.
#[derive(
	Encode, Decode, DecodeWithMemTracking, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen,
)]
pub struct Identity<BlockNumber> {
	/// Typed fields.
	pub typed: BoundedBTreeMap<FieldKind, FieldValue, MaxTypedFields>,
	/// Custom fields, by key.
	pub custom: BoundedBTreeMap<CustomKey, FieldValue, MaxCustomFields>,
	/// Links, in display order.
	pub links: BoundedVec<Link, MaxLinks>,
	/// Id given to the next added link.
	pub next_link_id: u32,
	/// Free text presentation, valid UTF-8.
	pub bio: Bio,
	/// Avatar image, if any.
	pub avatar: Option<AvatarBytes>,
	/// Block at which the identity was created.
	pub created_at: BlockNumber,
	/// Block of the last change.
	pub updated_at: BlockNumber,
}

impl<BlockNumber: Copy> Identity<BlockNumber> {
	/// An empty identity created at `now`.
	pub fn new(now: BlockNumber) -> Self {
		Self {
			typed: Default::default(),
			custom: Default::default(),
			links: Default::default(),
			next_link_id: 0,
			bio: Default::default(),
			avatar: None,
			created_at: now,
			updated_at: now,
		}
	}
}

/// An identity authority: an organisation whose agents may attest and migrate identities.
#[derive(
	Encode, Decode, DecodeWithMemTracking, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen,
)]
pub struct AuthorityInfo {
	/// Display name, valid UTF-8.
	pub name: AuthorityName,
	/// An inactive authority's agents cannot act.
	pub active: bool,
}

/// What an authority's agent is allowed to do, as a set of bits.
///
/// Encoded as a plain `u8`, so clients show a number: `1` attest fields, `2` person facts,
/// `4` manage names, `8` migrate; `3` is the first two together.
#[derive(
	Encode,
	Decode,
	DecodeWithMemTracking,
	Clone,
	Copy,
	PartialEq,
	Eq,
	Debug,
	TypeInfo,
	MaxEncodedLen,
)]
pub struct Capabilities(u8);

impl Capabilities {
	/// Attest control of a field, and its failures.
	pub const ATTEST_FIELDS: Self = Self(1);
	/// Record facts about the person behind an identity.
	pub const PERSON_FACTS: Self = Self(2);
	/// Reserve names, assign them and revoke them.
	pub const MANAGE_NAMES: Self = Self(4);
	/// Fulfil migration requests and import judgements.
	pub const MIGRATE: Self = Self(8);
	/// Every capability defined so far.
	pub const ALL: Self = Self(1 | 2 | 4 | 8);

	/// The capabilities given by `bits`, or `None` if `bits` sets a bit that is not a capability.
	pub fn from_bits(bits: u8) -> Option<Self> {
		(bits & !Self::ALL.0 == 0).then_some(Self(bits))
	}

	/// The raw bits.
	pub fn bits(self) -> u8 {
		self.0
	}

	/// Whether no capability is set.
	pub fn is_empty(self) -> bool {
		self.0 == 0
	}

	/// Whether every capability of `other` is also in `self`.
	pub fn contains(self, other: Self) -> bool {
		self.0 & other.0 == other.0
	}
}

impl core::ops::BitOr for Capabilities {
	type Output = Self;

	fn bitor(self, other: Self) -> Self {
		Self(self.0 | other.0)
	}
}

/// What an authority concluded when it checked a field.
#[derive(
	Encode,
	Decode,
	DecodeWithMemTracking,
	Clone,
	Copy,
	PartialEq,
	Eq,
	Debug,
	TypeInfo,
	MaxEncodedLen,
)]
pub enum Verdict {
	/// The person controls the value.
	Verified,
	/// The value was checked and refused (disposable or unreliable, for instance a temporary
	/// email). A rejected field counts as not verified.
	Rejected,
}

/// The People Chain a migration comes from.
#[derive(
	Encode,
	Decode,
	DecodeWithMemTracking,
	Clone,
	Copy,
	PartialEq,
	Eq,
	Debug,
	TypeInfo,
	MaxEncodedLen,
)]
pub enum SourceChain {
	Polkadot,
	Kusama,
}

/// The judgement of a People Chain registrar on an identity, as `pallet-identity` records it
/// (`FeePaid` without its amount).
#[derive(
	Encode,
	Decode,
	DecodeWithMemTracking,
	Clone,
	Copy,
	PartialEq,
	Eq,
	Debug,
	TypeInfo,
	MaxEncodedLen,
)]
pub enum JudgementLevel {
	Unknown,
	FeePaid,
	Reasonable,
	KnownGood,
	OutOfDate,
	LowQuality,
	Erroneous,
}

/// The judgements of an identity on a People Chain: `(registrar index, judgement)`, at most one
/// per registrar.
pub type ImportedJudgements = BoundedVec<(u32, JudgementLevel), MaxImportedJudgements>;

/// What the migration service read of an identity on a People Chain, as given to
/// `fulfil_migration`. Every value is checked like a user write; a key given twice is refused.
#[derive(
	Encode, Decode, DecodeWithMemTracking, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen,
)]
pub struct MigrationPayload {
	/// Typed fields, each kind at most once.
	pub typed: BoundedVec<(FieldKind, Value), MaxTypedFields>,
	/// Custom fields (the `additional` fields of the source), each key at most once.
	pub custom: BoundedVec<(CustomKey, Value), MaxCustomFields>,
	/// Every registrar judgement of the identity, at most one per registrar.
	pub judgements: ImportedJudgements,
}

/// How an authority checked a field.
#[derive(
	Encode,
	Decode,
	DecodeWithMemTracking,
	Clone,
	Copy,
	PartialEq,
	Eq,
	Debug,
	TypeInfo,
	MaxEncodedLen,
)]
pub enum Method {
	EmailCode,
	OAuth,
	MatrixChallenge,
	PgpSignature,
	Dns,
	WebFile,
	Manual,
	/// Imported from a registrar judgement on a People Chain, at a source block. Set by the
	/// migration only, never by `provide_judgement`.
	MigratedFromPeopleChain {
		source: SourceChain,
		registrar: u32,
		block: u32,
	},
	/// The owner sent a one-time code to the authority's bot from the account named in the field
	/// (Telegram).
	BotChallenge,
}

/// Structured reason of a fact, a refusal or a revocation.
#[derive(
	Encode,
	Decode,
	DecodeWithMemTracking,
	Clone,
	Copy,
	PartialEq,
	Eq,
	Debug,
	TypeInfo,
	MaxEncodedLen,
)]
pub enum ReasonCode {
	Unspecified,
	ValueMismatch,
	Disposable,
	Impersonation,
	DocumentInvalid,
	UserRequest,
	Abuse,
	Other,
}

/// A fact about the person behind an identity, recorded by an authority.
#[derive(
	Encode,
	Decode,
	DecodeWithMemTracking,
	Clone,
	Copy,
	PartialEq,
	Eq,
	PartialOrd,
	Ord,
	Debug,
	TypeInfo,
	MaxEncodedLen,
)]
pub enum FactKind {
	/// The authority checked an identity document (KYC).
	DocumentChecked,
	/// The authority found fraud.
	Fraud,
}

impl FactKind {
	/// Number of kinds: bounds the facts of an identity per authority.
	pub const COUNT: u32 = 2;
}

/// The trust level of an identity, computed from its attestations and facts (see
/// [`crate::trust`]), never stored. The only public vocabulary of verification.
#[derive(
	Encode,
	Decode,
	DecodeWithMemTracking,
	Clone,
	Copy,
	PartialEq,
	Eq,
	Debug,
	TypeInfo,
	MaxEncodedLen,
)]
pub enum TrustLevel {
	/// An authority recorded a fraud that is still active.
	Fraudulent,
	/// The identity is set and nothing is verified.
	Declared,
	/// At least one field is verified.
	PartiallyVerified,
	/// Every verifiable typed field present is verified.
	FullyVerified,
	/// Fully verified, and an authority checked an identity document.
	Certified,
}

/// What an attestation request asks an authority for.
#[derive(
	Encode, Decode, DecodeWithMemTracking, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen,
)]
pub enum Target {
	/// Check a field (typed, custom, or a link).
	Field(FieldKey),
	/// Record a fact about the person.
	Fact(FactKind),
}

/// An authority's attestation of a field, tied to the value it checked.
#[derive(
	Encode, Decode, DecodeWithMemTracking, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen,
)]
pub struct FieldAttestation<BlockNumber> {
	/// Commitment of the value checked (see `attestations.rs`): the attestation is only valid
	/// while the field still has this commitment.
	pub commitment: H256,
	pub verdict: Verdict,
	pub method: Method,
	pub issued_at: BlockNumber,
	/// Last block at which the attestation is valid, if it expires.
	pub expires_at: Option<BlockNumber>,
	/// Block and reason of the revocation, if revoked.
	pub revoked: Option<(BlockNumber, ReasonCode)>,
}

/// A fact about the person behind an identity.
#[derive(
	Encode, Decode, DecodeWithMemTracking, Clone, PartialEq, Eq, Debug, TypeInfo, MaxEncodedLen,
)]
pub struct Fact<BlockNumber> {
	pub issued_at: BlockNumber,
	/// Last block at which the fact is active, if it expires.
	pub expires_at: Option<BlockNumber>,
	pub reason: ReasonCode,
	/// Valid UTF-8.
	pub note: Note,
	/// Block and reason of the revocation, if revoked.
	pub revoked: Option<(BlockNumber, ReasonCode)>,
}

/// An authority present at genesis, as written in a chain spec preset:
/// `{ "name": "identitee", "agents": [{ "account": "5Grw…", "caps": 15 }] }`.
#[derive(Clone, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenesisAuthority<AccountId> {
	/// Display name, at most [`MAX_AUTHORITY_NAME_LEN`] bytes of UTF-8.
	pub name: alloc::string::String,
	/// Its agents.
	pub agents: alloc::vec::Vec<GenesisAgent<AccountId>>,
}

/// An agent of a [`GenesisAuthority`]: its account and its capability bits (see
/// [`Capabilities`]: `1` attest fields, `2` person facts, `4` manage names, `8` migrate).
#[derive(Clone, PartialEq, Eq, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenesisAgent<AccountId> {
	pub account: AccountId,
	pub caps: u8,
}
