#[test_only]
module agentic_mesh::relay_registry_tests {
    use agentic_mesh::relay_registry::{Self as relay_registry, RelayDeactivated, RelayHeartbeat, RelayNode, RelayRegistered, RelaySlashed};
    use agentic_mesh::staking::{Self as staking, StakePosition};
    use std::string::{Self as string};
    use sui::clock::{Self as clock, Clock};
    use sui::coin;
    use sui::event;
    use sui::sui::SUI;
    use sui::test_scenario::{Self as ts};

    const OPERATOR: address = @0xA;
    const OUTSIDER: address = @0xB;
    const HUNDRED_SUI: u64 = 100_000_000_000;

    fun create_clock(scenario: &mut ts::Scenario): Clock {
        let mut test_clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut test_clock, 1_000);
        test_clock
    }

    fun deposit_relay_stake(scenario: &mut ts::Scenario, owner: address, test_clock: &Clock): ID {
        scenario.next_tx(owner);
        {
            let payment = coin::mint_for_testing<SUI>(HUNDRED_SUI, scenario.ctx());
            staking::deposit_stake(payment, staking::relay_stake_type(), test_clock, scenario.ctx());
            let events = event::events_by_type<staking::StakeDeposited>();
            staking::deposited_event_stake_id(events.borrow(events.length() - 1))
        }
    }

    fun register_relay_node(
        scenario: &mut ts::Scenario,
        sender: address,
        stake_id: ID,
        test_clock: &Clock,
    ): ID {
        scenario.next_tx(sender);
        {
            let stake_position = scenario.take_shared_by_id<StakePosition>(stake_id);
            relay_registry::register_relay(
                string::utf8(b"wss://relay.mesh.example/ws"),
                &stake_position,
                vector[string::utf8(b"routing"), string::utf8(b"streaming")],
                string::utf8(b"us-east"),
                50,
                test_clock,
                scenario.ctx(),
            );
            ts::return_shared(stake_position);
            let events = event::events_by_type<RelayRegistered>();
            relay_registry::registered_event_relay_id(events.borrow(events.length() - 1))
        }
    }

    #[test]
    fun test_register_relay_creates_shared_node() {
        let mut scenario = ts::begin(OPERATOR);
        let test_clock = create_clock(&mut scenario);
        let stake_id = deposit_relay_stake(&mut scenario, OPERATOR, &test_clock);
        let relay_id = register_relay_node(&mut scenario, OPERATOR, stake_id, &test_clock);

        let events = event::events_by_type<RelayRegistered>();
        let registered = events.borrow(events.length() - 1);
        assert!(relay_registry::registered_event_operator(registered) == OPERATOR);
        assert!(relay_registry::registered_event_region(registered) == string::utf8(b"us-east"));
        assert!(relay_registry::registered_event_routing_fee_bps(registered) == 50);

        scenario.next_tx(OUTSIDER);
        {
            let relay = scenario.take_shared_by_id<RelayNode>(relay_id);
            assert!(relay_registry::relay_operator(&relay) == OPERATOR);
            assert!(relay_registry::relay_endpoint(&relay) == string::utf8(b"wss://relay.mesh.example/ws"));
            assert!(relay_registry::relay_stake_position_id(&relay) == stake_id);
            assert!(relay_registry::relay_region(&relay) == string::utf8(b"us-east"));
            assert!(relay_registry::relay_status(&relay) == relay_registry::status_active());
            assert!(relay_registry::relay_registered_at(&relay) == 1_000);
            assert!(relay_registry::relay_last_heartbeat(&relay) == 1_000);
            assert!(relay_registry::relay_routing_fee_bps(&relay) == 50);
            let capabilities = relay_registry::relay_capabilities(&relay);
            assert!(capabilities.length() == 2);
            assert!(*capabilities.borrow(0) == string::utf8(b"routing"));
            assert!(*capabilities.borrow(1) == string::utf8(b"streaming"));
            ts::return_shared(relay);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 1)]
    fun test_register_requires_stake_owner() {
        let mut scenario = ts::begin(OPERATOR);
        let test_clock = create_clock(&mut scenario);
        let stake_id = deposit_relay_stake(&mut scenario, OPERATOR, &test_clock);
        let _relay_id = register_relay_node(&mut scenario, OUTSIDER, stake_id, &test_clock);

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_heartbeat_updates_timestamp() {
        let mut scenario = ts::begin(OPERATOR);
        let mut test_clock = create_clock(&mut scenario);
        let stake_id = deposit_relay_stake(&mut scenario, OPERATOR, &test_clock);
        let relay_id = register_relay_node(&mut scenario, OPERATOR, stake_id, &test_clock);

        clock::set_for_testing(&mut test_clock, 2_500);
        scenario.next_tx(OPERATOR);
        {
            let mut relay = scenario.take_shared_by_id<RelayNode>(relay_id);
            relay_registry::heartbeat(&mut relay, &test_clock, scenario.ctx());
            assert!(relay_registry::relay_last_heartbeat(&relay) == 2_500);
            ts::return_shared(relay);
        };

        let events = event::events_by_type<RelayHeartbeat>();
        let heartbeat = events.borrow(events.length() - 1);
        assert!(relay_registry::heartbeat_event_relay_id(heartbeat) == relay_id);
        assert!(relay_registry::heartbeat_event_last_heartbeat(heartbeat) == 2_500);

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_record_routing_updates_counters() {
        let mut scenario = ts::begin(OPERATOR);
        let test_clock = create_clock(&mut scenario);
        let stake_id = deposit_relay_stake(&mut scenario, OPERATOR, &test_clock);
        let relay_id = register_relay_node(&mut scenario, OPERATOR, stake_id, &test_clock);

        scenario.next_tx(OPERATOR);
        {
            let mut relay = scenario.take_shared_by_id<RelayNode>(relay_id);
            relay_registry::record_routing(&mut relay, 12_345, scenario.ctx());
            assert!(relay_registry::relay_total_routed(&relay) == 1);
            assert!(relay_registry::relay_total_fees_earned(&relay) == 12_345);
            ts::return_shared(relay);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_deactivate_relay_sets_inactive_status() {
        let mut scenario = ts::begin(OPERATOR);
        let test_clock = create_clock(&mut scenario);
        let stake_id = deposit_relay_stake(&mut scenario, OPERATOR, &test_clock);
        let relay_id = register_relay_node(&mut scenario, OPERATOR, stake_id, &test_clock);

        scenario.next_tx(OPERATOR);
        {
            let mut relay = scenario.take_shared_by_id<RelayNode>(relay_id);
            relay_registry::deactivate_relay(&mut relay, scenario.ctx());
            assert!(relay_registry::relay_status(&relay) == relay_registry::status_inactive());
            ts::return_shared(relay);
        };

        let events = event::events_by_type<RelayDeactivated>();
        let deactivated = events.borrow(events.length() - 1);
        assert!(relay_registry::deactivated_event_relay_id(deactivated) == relay_id);
        assert!(relay_registry::deactivated_event_status(deactivated) == relay_registry::status_inactive());

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_slash_relay_sets_slashed_status() {
        let mut scenario = ts::begin(OPERATOR);
        let test_clock = create_clock(&mut scenario);
        let stake_id = deposit_relay_stake(&mut scenario, OPERATOR, &test_clock);
        let relay_id = register_relay_node(&mut scenario, OPERATOR, stake_id, &test_clock);

        scenario.next_tx(OUTSIDER);
        {
            let mut relay = scenario.take_shared_by_id<RelayNode>(relay_id);
            relay_registry::slash_relay(&mut relay);
            assert!(relay_registry::relay_status(&relay) == relay_registry::status_slashed());
            ts::return_shared(relay);
        };

        let events = event::events_by_type<RelaySlashed>();
        let slashed = events.borrow(events.length() - 1);
        assert!(relay_registry::slashed_event_relay_id(slashed) == relay_id);
        assert!(relay_registry::slashed_event_status(slashed) == relay_registry::status_slashed());

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }
}
