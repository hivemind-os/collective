#[test_only]
module agentic_mesh::reputation_tests {
    use agentic_mesh::registry::{Self as registry, AgentCard, AgentRegistered, Registry};
    use agentic_mesh::reputation::{Self as reputation, AnchorPublished, ReputationAnchor};
    use agentic_mesh::task::{Self as task, Task};
    use std::string::{Self, String};
    use sui::clock::{Self, Clock};
    use sui::coin;
    use sui::event;
    use sui::sui::SUI;
    use sui::test_scenario::{Self as ts};

    const REQUESTER: address = @0xA;
    const PROVIDER: address = @0xB;
    const ONE_SUI: u64 = 1_000_000_000;

    fun create_clock(scenario: &mut ts::Scenario): Clock {
        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, 1_000);
        clock
    }

    fun register_provider(scenario: &mut ts::Scenario, clock: &Clock) {
        scenario.next_tx(PROVIDER);
        {
            let mut registry_obj = scenario.take_shared<Registry>();
            registry::register_agent(
                &mut registry_obj,
                string::utf8(b"Provider"),
                string::utf8(b"did:mesh:provider"),
                string::utf8(b"Reputation test provider"),
                vector[string::utf8(b"echo")],
                vector[string::utf8(b"Echo input")],
                vector[string::utf8(b"1.0.0")],
                vector[ONE_SUI],
                vector[string::utf8(b"MIST")],
                string::utf8(b"https://mesh.example/provider"),
                clock,
                scenario.ctx(),
            );
            ts::return_shared(registry_obj);
        }
    }

    fun post_default_task(scenario: &mut ts::Scenario, clock: &Clock): ID {
        scenario.next_tx(REQUESTER);
        {
            let payment = coin::mint_for_testing<SUI>(ONE_SUI, scenario.ctx());
            task::post_task(
                string::utf8(b"echo"),
                string::utf8(b"general"),
                b"input-blob",
                b"agreement-hash",
                payment,
                60_000,
                1,
                clock,
                scenario.ctx(),
            );
            let events = event::events_by_type<task::TaskPosted>();
            task::posted_event_task_id(events.borrow(0))
        }
    }

    #[test]
    fun test_publish_anchor_stores_fields() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);

        scenario.next_tx(REQUESTER);
        {
            reputation::publish_anchor(b"0123456789abcdef0123456789abcdef", 2, b"walrus:blob-id", 100, 200, &clock, scenario.ctx());
            let events = event::events_by_type<AnchorPublished>();
            assert!(events.length() == 1);
            let published = events.borrow(0);
            assert!(reputation::published_event_author(published) == REQUESTER);
            assert!(reputation::published_event_merkle_root(published) == b"0123456789abcdef0123456789abcdef");
            assert!(reputation::published_event_event_count(published) == 2);
        };

        scenario.next_tx(REQUESTER);
        {
            let anchor = scenario.take_from_sender<ReputationAnchor>();
            assert!(reputation::anchor_author(&anchor) == REQUESTER);
            assert!(reputation::anchor_merkle_root(&anchor) == b"0123456789abcdef0123456789abcdef");
            assert!(reputation::anchor_event_count(&anchor) == 2);
            assert!(reputation::anchor_blob_id(&anchor) == b"walrus:blob-id");
            assert!(reputation::anchor_from_timestamp(&anchor) == 100);
            assert!(reputation::anchor_to_timestamp(&anchor) == 200);
            assert!(reputation::anchor_created_at(&anchor) == 1_000);
            scenario.return_to_sender(anchor);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 1)]
    fun test_publish_anchor_rejects_invalid_merkle_root() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);

        scenario.next_tx(REQUESTER);
        {
            reputation::publish_anchor(b"short-root", 1, b"walrus:blob-id", 100, 200, &clock, scenario.ctx());
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 2)]
    fun test_publish_anchor_rejects_zero_event_count() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);

        scenario.next_tx(REQUESTER);
        {
            reputation::publish_anchor(b"0123456789abcdef0123456789abcdef", 0, b"walrus:blob-id", 100, 200, &clock, scenario.ctx());
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 4)]
    fun test_publish_anchor_rejects_inverted_time_range() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);

        scenario.next_tx(REQUESTER);
        {
            reputation::publish_anchor(b"0123456789abcdef0123456789abcdef", 1, b"walrus:blob-id", 200, 100, &clock, scenario.ctx());
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_agent_card_reputation_counters_increment() {
        let mut scenario = ts::begin(REQUESTER);
        registry::init_for_testing(scenario.ctx());
        let clock = create_clock(&mut scenario);
        register_provider(&mut scenario, &clock);

        scenario.next_tx(PROVIDER);
        {
            let mut card = scenario.take_from_sender<AgentCard>();
            reputation::record_task_completion(&mut card);
            reputation::record_task_failure(&mut card);
            reputation::record_task_dispute(&mut card);
            reputation::record_payment(&mut card, 42);
            assert!(registry::card_total_tasks_completed(&card) == 1);
            assert!(registry::card_total_tasks_failed(&card) == 1);
            assert!(registry::card_total_tasks_disputed(&card) == 1);
            assert!(registry::card_total_earnings_mist(&card) == 42);
            scenario.return_to_sender(card);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_task_completion_with_card_updates_reputation_counter() {
        let mut scenario = ts::begin(REQUESTER);
        registry::init_for_testing(scenario.ctx());
        let clock = create_clock(&mut scenario);
        register_provider(&mut scenario, &clock);
        let task_id = post_default_task(&mut scenario, &clock);

        scenario.next_tx(PROVIDER);
        {
            let mut task_obj = scenario.take_shared_by_id<Task>(task_id);
            task::accept_task(&mut task_obj, &clock, scenario.ctx());
            ts::return_shared(task_obj);
        };

        scenario.next_tx(PROVIDER);
        {
            let mut task_obj = scenario.take_shared_by_id<Task>(task_id);
            let mut card = scenario.take_from_sender<AgentCard>();
            task::complete_task_with_card(&mut task_obj, &mut card, b"result-blob", &clock, scenario.ctx());
            assert!(registry::card_total_tasks_completed(&card) == 1);
            scenario.return_to_sender(card);
            ts::return_shared(task_obj);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }
}
