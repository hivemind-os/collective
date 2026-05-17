#[test_only]
module agentic_mesh::registry_tests {
    use agentic_mesh::registry::{Self, AgentCard, AgentDeactivated, AgentRegistered, AgentUpdated, Registry};
    use std::string::{Self, String};
    use sui::clock::{Self, Clock};
    use sui::event;
    use sui::test_scenario::{Self as ts};

    const AGENT_A: address = @0xA;
    const AGENT_B: address = @0xB;
    const AGENT_C: address = @0xC;

    fun create_clock(scenario: &mut ts::Scenario): Clock {
        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, 1_000);
        clock
    }

    fun single_capability_vectors(): (vector<String>, vector<String>, vector<String>, vector<u64>, vector<String>) {
        (
            vector[string::utf8(b"text-generation")],
            vector[string::utf8(b"Generate helpful text")],
            vector[string::utf8(b"1.0.0")],
            vector[1_000_000],
            vector[string::utf8(b"SUI")],
        )
    }

    fun multi_capability_vectors(): (vector<String>, vector<String>, vector<String>, vector<u64>, vector<String>) {
        (
            vector[string::utf8(b"text-generation"), string::utf8(b"summarization")],
            vector[string::utf8(b"Generate helpful text"), string::utf8(b"Summarize documents")],
            vector[string::utf8(b"1.0.0"), string::utf8(b"2.1.0")],
            vector[1_000_000, 2_500_000],
            vector[string::utf8(b"SUI"), string::utf8(b"USDC")],
        )
    }

    fun empty_capability_vectors(): (vector<String>, vector<String>, vector<String>, vector<u64>, vector<String>) {
        (vector[], vector[], vector[], vector[], vector[])
    }

    fun register_agent_with_vectors(
        scenario: &mut ts::Scenario,
        agent: address,
        clock: &Clock,
        name: String,
        did: String,
        description: String,
        cap_names: vector<String>,
        cap_descriptions: vector<String>,
        cap_versions: vector<String>,
        cap_prices: vector<u64>,
        cap_currencies: vector<String>,
        endpoint: String,
    ): ID {
        scenario.next_tx(agent);
        {
            let mut reg = scenario.take_shared<Registry>();
            registry::register_agent(
                &mut reg,
                name,
                did,
                description,
                cap_names,
                cap_descriptions,
                cap_versions,
                cap_prices,
                cap_currencies,
                endpoint,
                @0x0,
                clock,
                scenario.ctx(),
            );
            let events = event::events_by_type<AgentRegistered>();
            assert!(events.length() == 1);
            let card_id = registry::registered_event_card_id(events.borrow(0));
            ts::return_shared(reg);
            card_id
        }
    }

    fun register_default_agent(
        scenario: &mut ts::Scenario,
        agent: address,
        clock: &Clock,
        name: vector<u8>,
        did: vector<u8>,
    ): ID {
        let (cap_names, cap_descriptions, cap_versions, cap_prices, cap_currencies) =
            single_capability_vectors();
        register_agent_with_vectors(
            scenario,
            agent,
            clock,
            string::utf8(name),
            string::utf8(did),
            string::utf8(b"Production agent"),
            cap_names,
            cap_descriptions,
            cap_versions,
            cap_prices,
            cap_currencies,
            string::utf8(b"https://mesh.example/agent"),
        )
    }

    #[test]
    fun test_register_agent_successfully() {
        let mut scenario = ts::begin(AGENT_A);
        registry::init_for_testing(scenario.ctx());
        let clock = create_clock(&mut scenario);

        let expected_card_id = register_default_agent(
            &mut scenario,
            AGENT_A,
            &clock,
            b"Agent A",
            b"did:mesh:agentA",
        );

        scenario.next_tx(AGENT_A);
        {
            let reg = scenario.take_shared<Registry>();
            let card = scenario.take_from_sender<AgentCard>();
            assert!(registry::active_count(&reg) == 1);
            assert!(registry::is_registered(&reg, AGENT_A));
            assert!(registry::card_id(&card) == expected_card_id);
            assert!(registry::card_name(&card) == string::utf8(b"Agent A"));
            assert!(registry::card_did(&card) == string::utf8(b"did:mesh:agentA"));
            assert!(registry::card_description(&card) == string::utf8(b"Production agent"));
            assert!(registry::card_endpoint(&card) == string::utf8(b"https://mesh.example/agent"));
            assert!(registry::card_encryption_public_key(&card).length() == 0);
            assert!(registry::card_active(&card));
            assert!(registry::card_version(&card) == 1);
            assert!(registry::card_registered_at(&card) == 1_000);
            assert!(registry::card_updated_at(&card) == 1_000);
            assert!(registry::card_owner(&card) == AGENT_A);
            let caps = registry::card_capabilities(&card);
            assert!(caps.length() == 1);
            assert!(registry::capability_name(caps.borrow(0)) == string::utf8(b"text-generation"));
            scenario.return_to_sender(card);
            ts::return_shared(reg);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_register_with_multiple_capabilities() {
        let mut scenario = ts::begin(AGENT_A);
        registry::init_for_testing(scenario.ctx());
        let clock = create_clock(&mut scenario);

        let (cap_names, cap_descriptions, cap_versions, cap_prices, cap_currencies) =
            multi_capability_vectors();
        register_agent_with_vectors(
            &mut scenario,
            AGENT_A,
            &clock,
            string::utf8(b"Agent Multi"),
            string::utf8(b"did:mesh:multi"),
            string::utf8(b"Supports multiple skills"),
            cap_names,
            cap_descriptions,
            cap_versions,
            cap_prices,
            cap_currencies,
            string::utf8(b"https://mesh.example/multi"),
        );

        scenario.next_tx(AGENT_A);
        {
            let card = scenario.take_from_sender<AgentCard>();
            let caps = registry::card_capabilities(&card);
            assert!(caps.length() == 2);
            assert!(registry::capability_name(caps.borrow(0)) == string::utf8(b"text-generation"));
            assert!(registry::capability_description(caps.borrow(1)) == string::utf8(b"Summarize documents"));
            assert!(registry::capability_version(caps.borrow(1)) == string::utf8(b"2.1.0"));
            assert!(registry::capability_price_mist(caps.borrow(1)) == 2_500_000);
            assert!(registry::capability_currency(caps.borrow(1)) == string::utf8(b"USDC"));
            scenario.return_to_sender(card);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 0)]
    fun test_duplicate_registration_fails() {
        let mut scenario = ts::begin(AGENT_A);
        registry::init_for_testing(scenario.ctx());
        let clock = create_clock(&mut scenario);

        register_default_agent(&mut scenario, AGENT_A, &clock, b"Agent A", b"did:mesh:agentA");

        let (cap_names, cap_descriptions, cap_versions, cap_prices, cap_currencies) =
            single_capability_vectors();
        register_agent_with_vectors(
            &mut scenario,
            AGENT_A,
            &clock,
            string::utf8(b"Agent A Again"),
            string::utf8(b"did:mesh:agentA2"),
            string::utf8(b"Duplicate"),
            cap_names,
            cap_descriptions,
            cap_versions,
            cap_prices,
            cap_currencies,
            string::utf8(b"https://mesh.example/duplicate"),
        );

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_update_agent_basic_fields() {
        let mut scenario = ts::begin(AGENT_A);
        registry::init_for_testing(scenario.ctx());
        let mut clock = create_clock(&mut scenario);

        register_default_agent(&mut scenario, AGENT_A, &clock, b"Agent A", b"did:mesh:agentA");
        clock::set_for_testing(&mut clock, 2_000);

        scenario.next_tx(AGENT_A);
        {
            let reg = scenario.take_shared<Registry>();
            let mut card = scenario.take_from_sender<AgentCard>();
            registry::update_agent(
                &reg,
                &mut card,
                string::utf8(b"Agent A Updated"),
                string::utf8(b"Updated production profile"),
                string::utf8(b"https://mesh.example/updated"),
                @0x0,
                &clock,
                scenario.ctx(),
            );
            assert!(registry::card_name(&card) == string::utf8(b"Agent A Updated"));
            assert!(registry::card_description(&card) == string::utf8(b"Updated production profile"));
            assert!(registry::card_endpoint(&card) == string::utf8(b"https://mesh.example/updated"));
            assert!(registry::card_version(&card) == 2);
            assert!(registry::card_updated_at(&card) == 2_000);
            scenario.return_to_sender(card);
            ts::return_shared(reg);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_set_encryption_key() {
        let mut scenario = ts::begin(AGENT_A);
        registry::init_for_testing(scenario.ctx());
        let clock = create_clock(&mut scenario);
        let encryption_key = x"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

        register_default_agent(&mut scenario, AGENT_A, &clock, b"Agent A", b"did:mesh:agentA");

        scenario.next_tx(AGENT_A);
        {
            let mut card = scenario.take_from_sender<AgentCard>();
            registry::set_encryption_key(&mut card, encryption_key, scenario.ctx());
            assert!(registry::card_encryption_public_key(&card) == encryption_key);
            scenario.return_to_sender(card);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_update_encryption_key() {
        let mut scenario = ts::begin(AGENT_A);
        registry::init_for_testing(scenario.ctx());
        let clock = create_clock(&mut scenario);
        let first_key = x"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
        let second_key = x"202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f";

        register_default_agent(&mut scenario, AGENT_A, &clock, b"Agent A", b"did:mesh:agentA");

        scenario.next_tx(AGENT_A);
        {
            let mut card = scenario.take_from_sender<AgentCard>();
            registry::set_encryption_key(&mut card, first_key, scenario.ctx());
            registry::set_encryption_key(&mut card, second_key, scenario.ctx());
            assert!(registry::card_encryption_public_key(&card) == second_key);
            scenario.return_to_sender(card);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_query_encryption_key() {
        let mut scenario = ts::begin(AGENT_A);
        registry::init_for_testing(scenario.ctx());
        let clock = create_clock(&mut scenario);
        let encryption_key = x"404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f";

        register_default_agent(&mut scenario, AGENT_A, &clock, b"Agent A", b"did:mesh:agentA");

        scenario.next_tx(AGENT_A);
        {
            let mut card = scenario.take_from_sender<AgentCard>();
            registry::set_encryption_key(&mut card, encryption_key, scenario.ctx());
            let queried_key = registry::card_encryption_public_key(&card);
            assert!(queried_key == encryption_key);
            scenario.return_to_sender(card);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_update_capabilities() {
        let mut scenario = ts::begin(AGENT_A);
        registry::init_for_testing(scenario.ctx());
        let mut clock = create_clock(&mut scenario);

        register_default_agent(&mut scenario, AGENT_A, &clock, b"Agent A", b"did:mesh:agentA");
        clock::set_for_testing(&mut clock, 2_000);

        scenario.next_tx(AGENT_A);
        {
            let reg = scenario.take_shared<Registry>();
            let mut card = scenario.take_from_sender<AgentCard>();
            registry::update_capabilities(
                &reg,
                &mut card,
                vector[string::utf8(b"reasoning"), string::utf8(b"translation")],
                vector[string::utf8(b"Chain-of-thought quality reasoning"), string::utf8(b"Translate multilingual content")],
                vector[string::utf8(b"3.0.0"), string::utf8(b"1.2.4")],
                vector[5_000_000, 3_000_000],
                vector[string::utf8(b""), string::utf8(b"SUI")],
                &clock,
                scenario.ctx(),
            );
            let caps = registry::card_capabilities(&card);
            assert!(caps.length() == 2);
            assert!(registry::capability_name(caps.borrow(0)) == string::utf8(b"reasoning"));
            assert!(registry::capability_currency(caps.borrow(0)) == string::utf8(b"SUI"));
            assert!(registry::capability_name(caps.borrow(1)) == string::utf8(b"translation"));
            assert!(registry::card_version(&card) == 2);
            scenario.return_to_sender(card);
            ts::return_shared(reg);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_version_increments_on_update() {
        let mut scenario = ts::begin(AGENT_A);
        registry::init_for_testing(scenario.ctx());
        let mut clock = create_clock(&mut scenario);

        register_default_agent(&mut scenario, AGENT_A, &clock, b"Agent A", b"did:mesh:agentA");
        clock::set_for_testing(&mut clock, 2_000);

        scenario.next_tx(AGENT_A);
        {
            let reg = scenario.take_shared<Registry>();
            let mut card = scenario.take_from_sender<AgentCard>();
            registry::update_agent(
                &reg,
                &mut card,
                string::utf8(b"Agent A v2"),
                string::utf8(b"Updated once"),
                string::utf8(b"https://mesh.example/v2"),
                @0x0,
                &clock,
                scenario.ctx(),
            );
            scenario.return_to_sender(card);
            ts::return_shared(reg);
        };

        clock::set_for_testing(&mut clock, 3_000);
        scenario.next_tx(AGENT_A);
        {
            let reg = scenario.take_shared<Registry>();
            let mut card = scenario.take_from_sender<AgentCard>();
            let (cap_names, cap_descriptions, cap_versions, cap_prices, cap_currencies) =
                multi_capability_vectors();
            registry::update_capabilities(
                &reg,
                &mut card,
                cap_names,
                cap_descriptions,
                cap_versions,
                cap_prices,
                cap_currencies,
                &clock,
                scenario.ctx(),
            );
            assert!(registry::card_version(&card) == 3);
            assert!(registry::card_updated_at(&card) == 3_000);
            scenario.return_to_sender(card);
            ts::return_shared(reg);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 2)]
    fun test_non_owner_update_fails() {
        let mut scenario = ts::begin(AGENT_A);
        registry::init_for_testing(scenario.ctx());
        let clock = create_clock(&mut scenario);

        register_default_agent(&mut scenario, AGENT_A, &clock, b"Agent A", b"did:mesh:agentA");

        scenario.next_tx(AGENT_A);
        {
            let card = scenario.take_from_sender<AgentCard>();
            transfer::public_transfer(card, AGENT_B);
        };

        scenario.next_tx(AGENT_B);
        {
            let reg = scenario.take_shared<Registry>();
            let mut card = scenario.take_from_sender<AgentCard>();
            registry::update_agent(
                &reg,
                &mut card,
                string::utf8(b"Hacked"),
                string::utf8(b"Hacked"),
                string::utf8(b"https://mesh.example/hacked"),
                @0x0,
                &clock,
                scenario.ctx(),
            );
            scenario.return_to_sender(card);
            ts::return_shared(reg);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_deactivate_agent() {
        let mut scenario = ts::begin(AGENT_A);
        registry::init_for_testing(scenario.ctx());
        let clock = create_clock(&mut scenario);

        register_default_agent(&mut scenario, AGENT_A, &clock, b"Agent A", b"did:mesh:agentA");

        scenario.next_tx(AGENT_A);
        {
            let mut reg = scenario.take_shared<Registry>();
            let mut card = scenario.take_from_sender<AgentCard>();
            registry::deactivate_agent(&mut reg, &mut card, scenario.ctx());
            assert!(!registry::card_active(&card));
            assert!(registry::active_count(&reg) == 0);
            assert!(!registry::is_registered(&reg, AGENT_A));
            scenario.return_to_sender(card);
            ts::return_shared(reg);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 3)]
    fun test_double_deactivate_fails() {
        let mut scenario = ts::begin(AGENT_A);
        registry::init_for_testing(scenario.ctx());
        let clock = create_clock(&mut scenario);

        register_default_agent(&mut scenario, AGENT_A, &clock, b"Agent A", b"did:mesh:agentA");

        scenario.next_tx(AGENT_A);
        {
            let mut reg = scenario.take_shared<Registry>();
            let mut card = scenario.take_from_sender<AgentCard>();
            registry::deactivate_agent(&mut reg, &mut card, scenario.ctx());
            scenario.return_to_sender(card);
            ts::return_shared(reg);
        };

        scenario.next_tx(AGENT_A);
        {
            let mut reg = scenario.take_shared<Registry>();
            let mut card = scenario.take_from_sender<AgentCard>();
            registry::deactivate_agent(&mut reg, &mut card, scenario.ctx());
            scenario.return_to_sender(card);
            ts::return_shared(reg);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_active_count_tracks_correctly() {
        let mut scenario = ts::begin(AGENT_A);
        registry::init_for_testing(scenario.ctx());
        let clock = create_clock(&mut scenario);

        register_default_agent(&mut scenario, AGENT_A, &clock, b"Agent A", b"did:mesh:agentA");
        register_default_agent(&mut scenario, AGENT_B, &clock, b"Agent B", b"did:mesh:agentB");
        register_default_agent(&mut scenario, AGENT_C, &clock, b"Agent C", b"did:mesh:agentC");

        scenario.next_tx(AGENT_B);
        {
            let mut reg = scenario.take_shared<Registry>();
            let mut card = scenario.take_from_sender<AgentCard>();
            assert!(registry::active_count(&reg) == 3);
            registry::deactivate_agent(&mut reg, &mut card, scenario.ctx());
            scenario.return_to_sender(card);
            ts::return_shared(reg);
        };

        scenario.next_tx(AGENT_C);
        {
            let reg = scenario.take_shared<Registry>();
            assert!(registry::active_count(&reg) == 2);
            assert!(registry::is_registered(&reg, AGENT_A));
            assert!(!registry::is_registered(&reg, AGENT_B));
            assert!(registry::is_registered(&reg, AGENT_C));
            ts::return_shared(reg);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_register_with_empty_capabilities_succeeds() {
        let mut scenario = ts::begin(AGENT_A);
        registry::init_for_testing(scenario.ctx());
        let clock = create_clock(&mut scenario);

        let (cap_names, cap_descriptions, cap_versions, cap_prices, cap_currencies) =
            empty_capability_vectors();
        register_agent_with_vectors(
            &mut scenario,
            AGENT_A,
            &clock,
            string::utf8(b"No Cap Agent"),
            string::utf8(b"did:mesh:no-caps"),
            string::utf8(b"No advertised capabilities yet"),
            cap_names,
            cap_descriptions,
            cap_versions,
            cap_prices,
            cap_currencies,
            string::utf8(b"https://mesh.example/no-caps"),
        );

        scenario.next_tx(AGENT_A);
        {
            let card = scenario.take_from_sender<AgentCard>();
            assert!(registry::card_capabilities(&card).length() == 0);
            scenario.return_to_sender(card);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_register_with_long_strings_succeeds() {
        let mut scenario = ts::begin(AGENT_A);
        registry::init_for_testing(scenario.ctx());
        let clock = create_clock(&mut scenario);

        let (cap_names, cap_descriptions, cap_versions, cap_prices, cap_currencies) =
            single_capability_vectors();
        register_agent_with_vectors(
            &mut scenario,
            AGENT_A,
            &clock,
            string::utf8(b"Agent Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            string::utf8(b"did:mesh:123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"),
            string::utf8(b"A production-ready agent with a deliberately long metadata description for storage testing."),
            cap_names,
            cap_descriptions,
            cap_versions,
            cap_prices,
            cap_currencies,
            string::utf8(b"https://mesh.example/agents/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        );

        scenario.next_tx(AGENT_A);
        {
            let card = scenario.take_from_sender<AgentCard>();
            assert!(registry::card_name(&card) == string::utf8(b"Agent Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
            assert!(registry::card_did(&card) == string::utf8(b"did:mesh:123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"));
            assert!(registry::card_endpoint(&card) == string::utf8(b"https://mesh.example/agents/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
            scenario.return_to_sender(card);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_register_event_emitted_correctly() {
        let mut scenario = ts::begin(AGENT_A);
        registry::init_for_testing(scenario.ctx());
        let clock = create_clock(&mut scenario);

        let (cap_names, cap_descriptions, cap_versions, cap_prices, cap_currencies) =
            multi_capability_vectors();
        scenario.next_tx(AGENT_A);
        {
            let mut reg = scenario.take_shared<Registry>();
            registry::register_agent(
                &mut reg,
                string::utf8(b"Event Agent"),
                string::utf8(b"did:mesh:event-agent"),
                string::utf8(b"Event rich agent"),
                cap_names,
                cap_descriptions,
                cap_versions,
                cap_prices,
                cap_currencies,
                string::utf8(b"https://mesh.example/events"),
                @0x0,
                &clock,
                scenario.ctx(),
            );
            let events = event::events_by_type<AgentRegistered>();
            assert!(events.length() == 1);
            let evt = events.borrow(0);
            assert!(registry::registered_event_agent(evt) == AGENT_A);
            assert!(registry::registered_event_did(evt) == string::utf8(b"did:mesh:event-agent"));
            assert!(registry::registered_event_name(evt) == string::utf8(b"Event Agent"));
            assert!(registry::registered_event_description(evt) == string::utf8(b"Event rich agent"));
            assert!(registry::registered_event_capabilities(evt).length() == 2);
            assert!(registry::registered_event_endpoint(evt) == string::utf8(b"https://mesh.example/events"));
            assert!(registry::registered_event_active(evt));
            assert!(registry::registered_event_version(evt) == 1);
            assert!(registry::registered_event_registered_at(evt) == 1_000);
            assert!(registry::registered_event_updated_at(evt) == 1_000);
            ts::return_shared(reg);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_update_event_emitted_correctly() {
        let mut scenario = ts::begin(AGENT_A);
        registry::init_for_testing(scenario.ctx());
        let mut clock = create_clock(&mut scenario);

        register_default_agent(&mut scenario, AGENT_A, &clock, b"Agent A", b"did:mesh:agentA");
        clock::set_for_testing(&mut clock, 2_500);

        scenario.next_tx(AGENT_A);
        {
            let reg = scenario.take_shared<Registry>();
            let mut card = scenario.take_from_sender<AgentCard>();
            registry::update_agent(
                &reg,
                &mut card,
                string::utf8(b"Agent Event Update"),
                string::utf8(b"Updated metadata for event testing"),
                string::utf8(b"https://mesh.example/events/update"),
                @0x0,
                &clock,
                scenario.ctx(),
            );
            let events = event::events_by_type<AgentUpdated>();
            assert!(events.length() == 1);
            let evt = events.borrow(0);
            assert!(registry::updated_event_agent(evt) == AGENT_A);
            assert!(registry::updated_event_card_id(evt) == registry::card_id(&card));
            assert!(registry::updated_event_name(evt) == string::utf8(b"Agent Event Update"));
            assert!(registry::updated_event_description(evt) == string::utf8(b"Updated metadata for event testing"));
            assert!(registry::updated_event_capabilities(evt).length() == 1);
            assert!(registry::updated_event_endpoint(evt) == string::utf8(b"https://mesh.example/events/update"));
            assert!(registry::updated_event_active(evt));
            assert!(registry::updated_event_version(evt) == 2);
            assert!(registry::updated_event_updated_at(evt) == 2_500);
            scenario.return_to_sender(card);
            ts::return_shared(reg);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_deactivate_event_emitted_correctly() {
        let mut scenario = ts::begin(AGENT_A);
        registry::init_for_testing(scenario.ctx());
        let clock = create_clock(&mut scenario);

        register_default_agent(&mut scenario, AGENT_A, &clock, b"Agent A", b"did:mesh:agentA");

        scenario.next_tx(AGENT_A);
        {
            let mut reg = scenario.take_shared<Registry>();
            let mut card = scenario.take_from_sender<AgentCard>();
            let card_id = registry::card_id(&card);
            registry::deactivate_agent(&mut reg, &mut card, scenario.ctx());
            let events = event::events_by_type<AgentDeactivated>();
            assert!(events.length() == 1);
            let evt = events.borrow(0);
            assert!(registry::deactivated_event_agent(evt) == AGENT_A);
            assert!(registry::deactivated_event_card_id(evt) == card_id);
            assert!(!registry::deactivated_event_active(evt));
            assert!(registry::deactivated_event_version(evt) == 1);
            assert!(registry::deactivated_event_updated_at(evt) == 1_000);
            scenario.return_to_sender(card);
            ts::return_shared(reg);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 2)]
    fun test_non_owner_deactivate_fails() {
        let mut scenario = ts::begin(AGENT_A);
        registry::init_for_testing(scenario.ctx());
        let clock = create_clock(&mut scenario);

        register_default_agent(&mut scenario, AGENT_A, &clock, b"Agent A", b"did:mesh:agentA");

        scenario.next_tx(AGENT_A);
        {
            let card = scenario.take_from_sender<AgentCard>();
            transfer::public_transfer(card, AGENT_B);
        };

        scenario.next_tx(AGENT_B);
        {
            let mut reg = scenario.take_shared<Registry>();
            let mut card = scenario.take_from_sender<AgentCard>();
            registry::deactivate_agent(&mut reg, &mut card, scenario.ctx());
            scenario.return_to_sender(card);
            ts::return_shared(reg);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }
}
