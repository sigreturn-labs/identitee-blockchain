// This file is part of Substrate.

// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// 	http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! Genesis presets: `development` and `local_testnet` for local chains with the well-known
//! development keys, and `identitee_testnet` for the public testnet.

use crate::{AccountId, BalancesConfig, IdentiteeConfig, RuntimeGenesisConfig, SudoConfig};
use alloc::{vec, vec::Vec};
use frame_support::build_struct_json_patch;
use pallet_identitee::types::{Capabilities, GenesisAgent, GenesisAuthority};
use serde_json::Value;
use sp_consensus_aura::sr25519::AuthorityId as AuraId;
use sp_consensus_grandpa::AuthorityId as GrandpaId;
use sp_core::{ed25519, sr25519};
use sp_genesis_builder::{self, PresetId};
use sp_keyring::Sr25519Keyring;

/// Name of the public testnet preset (served at wss://rpc.identit.ee).
pub const IDENTITEE_TESTNET_PRESET: &str = "identitee_testnet";

/// The testnet operator account: sudo, endowed, agent of authority 0 with every capability.
pub const TESTNET_OWNER: [u8; 32] =
	hex32("fafe6ff6945e27f3c39fe8bf5a90cb0fa61b3c27c9faa3ba3741362643ee303f");
/// Migration service account (sr25519, its secret held by the service): agent with MIGRATE.
pub const TESTNET_MIGRATOR: [u8; 32] =
	hex32("549cd82f196063823096b2afad1a2de8318f52cdb7dc565ca9262222ff5feb01");
/// Verification service account (sr25519, its secret held by the service): agent with ATTEST_FIELDS
/// and PERSON_FACTS.
pub const TESTNET_VERIFIER: [u8; 32] =
	hex32("84a13ca0a7873fc954090b91368de6674d96850466119e42d5c9f24b57ab2c5f");
/// Aura key (sr25519) of the testnet validator.
pub const TESTNET_AURA: [u8; 32] =
	hex32("76aa53d78d26b912dc939a296515c39a5ed4a8d9eab70236a94f6a90e6563d6e");
/// GRANDPA key (ed25519, same secret phrase as the Aura key) of the testnet validator.
pub const TESTNET_GRANDPA: [u8; 32] =
	hex32("c6e785015b3baf71ea965fce5d02fbcc266a1f82be5b13e0f6f5f69eb2964e29");
/// Initial balance of the testnet owner: 1 000 000 IDT.
const TESTNET_OWNER_BALANCE: crate::Balance = 1_000_000 * crate::UNIT;

/// Decodes 64 hex digits at compile time (public keys are written in hex, not SS58: the runtime's
/// prefix 2426 is not a registered SS58 format and `AccountId32` serde would reject it).
const fn hex32(hex: &str) -> [u8; 32] {
	const fn digit(c: u8) -> u8 {
		match c {
			b'0'..=b'9' => c - b'0',
			b'a'..=b'f' => c - b'a' + 10,
			_ => panic!("lowercase hex expected"),
		}
	}
	let bytes = hex.as_bytes();
	assert!(bytes.len() == 64, "32 bytes expected");
	let mut out = [0u8; 32];
	let mut i = 0;
	while i < 32 {
		out[i] = digit(bytes[2 * i]) * 16 + digit(bytes[2 * i + 1]);
		i += 1;
	}
	out
}

/// The genesis config of the development presets: `initial_authorities` validate, every
/// `endowed_accounts` entry gets 2^60 planck, `root` is sudo, and Alice and Bob serve authority 0.
fn testnet_genesis(
	initial_authorities: Vec<(AuraId, GrandpaId)>,
	endowed_accounts: Vec<AccountId>,
	root: AccountId,
) -> Value {
	build_struct_json_patch!(RuntimeGenesisConfig {
		balances: BalancesConfig {
			balances: endowed_accounts
				.iter()
				.cloned()
				.map(|k| (k, 1u128 << 60))
				.collect::<Vec<_>>(),
		},
		aura: pallet_aura::GenesisConfig {
			authorities: initial_authorities.iter().map(|x| x.0.clone()).collect::<Vec<_>>(),
		},
		grandpa: pallet_grandpa::GenesisConfig {
			authorities: initial_authorities.iter().map(|x| (x.1.clone(), 1)).collect::<Vec<_>>(),
		},
		sudo: SudoConfig { key: Some(root) },
		identitee: IdentiteeConfig {
			authorities: identitee_authorities(
				Sr25519Keyring::Alice.to_account_id(),
				Sr25519Keyring::Bob.to_account_id(),
				vec![],
			),
		},
	})
}

/// Authority 0 "identitee", with `admin` as an agent holding every capability, `migrator` as
/// the migration service (migrate only), then the `others` agents. Test presets: Alice and Bob.
fn identitee_authorities(
	admin: AccountId,
	migrator: AccountId,
	others: Vec<GenesisAgent<AccountId>>,
) -> Vec<GenesisAuthority<AccountId>> {
	let mut agents = vec![
		GenesisAgent { account: admin, caps: Capabilities::ALL.bits() },
		GenesisAgent { account: migrator, caps: Capabilities::MIGRATE.bits() },
	];
	agents.extend(others);
	vec![GenesisAuthority { name: "identitee".into(), agents }]
}

/// Return the public testnet genesis config: one validator, the owner as sudo and full agent of
/// "identitee", the migrator as MIGRATE agent, the verifier as ATTEST_FIELDS and PERSON_FACTS
/// agent. Only the owner holds a balance.
pub fn identitee_testnet_config_genesis() -> Value {
	let owner = AccountId::from(TESTNET_OWNER);
	build_struct_json_patch!(RuntimeGenesisConfig {
		balances: BalancesConfig { balances: vec![(owner.clone(), TESTNET_OWNER_BALANCE)] },
		aura: pallet_aura::GenesisConfig {
			authorities: vec![AuraId::from(sr25519::Public::from_raw(TESTNET_AURA))],
		},
		grandpa: pallet_grandpa::GenesisConfig {
			authorities: vec![(GrandpaId::from(ed25519::Public::from_raw(TESTNET_GRANDPA)), 1)],
		},
		sudo: SudoConfig { key: Some(owner.clone()) },
		identitee: IdentiteeConfig {
			authorities: identitee_authorities(
				owner,
				AccountId::from(TESTNET_MIGRATOR),
				vec![GenesisAgent {
					account: AccountId::from(TESTNET_VERIFIER),
					caps: (Capabilities::ATTEST_FIELDS | Capabilities::PERSON_FACTS).bits(),
				}],
			),
		},
	})
}

/// Return the development genesis config.
pub fn development_config_genesis() -> Value {
	testnet_genesis(
		vec![(
			sp_keyring::Sr25519Keyring::Alice.public().into(),
			sp_keyring::Ed25519Keyring::Alice.public().into(),
		)],
		vec![
			Sr25519Keyring::Alice.to_account_id(),
			Sr25519Keyring::Bob.to_account_id(),
			Sr25519Keyring::AliceStash.to_account_id(),
			Sr25519Keyring::BobStash.to_account_id(),
		],
		sp_keyring::Sr25519Keyring::Alice.to_account_id(),
	)
}

/// Return the local genesis config preset.
pub fn local_config_genesis() -> Value {
	testnet_genesis(
		vec![
			(
				sp_keyring::Sr25519Keyring::Alice.public().into(),
				sp_keyring::Ed25519Keyring::Alice.public().into(),
			),
			(
				sp_keyring::Sr25519Keyring::Bob.public().into(),
				sp_keyring::Ed25519Keyring::Bob.public().into(),
			),
		],
		Sr25519Keyring::iter()
			.filter(|v| v != &Sr25519Keyring::One && v != &Sr25519Keyring::Two)
			.map(|v| v.to_account_id())
			.collect::<Vec<_>>(),
		Sr25519Keyring::Alice.to_account_id(),
	)
}

/// Provides the JSON representation of predefined genesis config for given `id`.
pub fn get_preset(id: &PresetId) -> Option<Vec<u8>> {
	let patch = match id.as_ref() {
		sp_genesis_builder::DEV_RUNTIME_PRESET => development_config_genesis(),
		sp_genesis_builder::LOCAL_TESTNET_RUNTIME_PRESET => local_config_genesis(),
		IDENTITEE_TESTNET_PRESET => identitee_testnet_config_genesis(),
		_ => return None,
	};
	Some(
		serde_json::to_string(&patch)
			.expect("serialization to json is expected to work. qed.")
			.into_bytes(),
	)
}

/// List of supported presets.
pub fn preset_names() -> Vec<PresetId> {
	vec![
		PresetId::from(sp_genesis_builder::DEV_RUNTIME_PRESET),
		PresetId::from(sp_genesis_builder::LOCAL_TESTNET_RUNTIME_PRESET),
		PresetId::from(IDENTITEE_TESTNET_PRESET),
	]
}
