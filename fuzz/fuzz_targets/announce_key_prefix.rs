#![no_main]

use libfuzzer_sys::fuzz_target;
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env};
use stealth_announcer::StealthAnnouncerClient;

fuzz_target!(|prefix: u8| {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(stealth_announcer::StealthAnnouncer, ());
    let client = StealthAnnouncerClient::new(&env, &contract_id);
    let caller = Address::generate(&env);
    let address = Bytes::from_slice(&env, &[0xaa; 20]);
    let mut key_bytes = [0xab; 33];
    key_bytes[0] = prefix;
    let key = Bytes::from_slice(&env, &key_bytes);
    let metadata = Bytes::from_slice(&env, &[0x42]);
    let _ = client.try_announce(&caller, &1, &address, &key, &metadata);
});
