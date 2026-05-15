#[test_only]
module agentic_mesh::staking_tests {
    use agentic_mesh::staking::{Self as staking, DeactivationStarted, SlashRecord, StakeDeposited, StakePosition, StakeSlashed, StakeWithdrawn};
    use agentic_mesh::task::{Self as task, Task, TaskPosted};
    use std::string::{Self, String};
    use sui::clock::{Self as clock, Clock};
    use sui::coin;
    use sui::event;
    use sui::sui::SUI;
    use sui::test_scenario::{Self as ts};

    const REQUESTER: address = @0xA;
    const PROVIDER: address = @0xB;
    const OUTSIDER: address = @0xC;

    const ONE_SUI: u64 = 1_000_000_000;
    const FIVE_SUI: u64 = 5_000_000_000;
    const TEN_SUI: u64 = 10_000_000_000;
    const FIFTEEN_SUI: u64 = 15_000_000_000;
    const TWENTY_SUI: u64 = 20_000_000_000;
    const HUNDRED_SUI: u64 = 100_000_000_000;
    const DISPUTE_WINDOW_MS: u64 = 60_000;
    const EXPIRY_HOURS: u64 = 1;

    fun create_clock(scenario: &mut ts::Scenario): Clock {
        let mut test_clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut test_clock, 1_000);
        test_clock
    }

    fun latest_deposit_event_stake_id(): ID {
        let events = event::events_by_type<StakeDeposited>();
        staking::deposited_event_stake_id(events.borrow(events.length() - 1))
    }

    fun deposit_stake_for_owner(
        scenario: &mut ts::Scenario,
        owner: address,
        amount: u64,
        stake_type: u8,
        test_clock: &Clock,
    ): ID {
        scenario.next_tx(owner);
        {
            let payment = coin::mint_for_testing<SUI>(amount, scenario.ctx());
            staking::deposit_stake(payment, stake_type, test_clock, scenario.ctx());
            latest_deposit_event_stake_id()
        }
    }

    fun post_default_task(scenario: &mut ts::Scenario, test_clock: &Clock, amount: u64): ID {
        scenario.next_tx(REQUESTER);
        {
            let payment = coin::mint_for_testing<SUI>(amount, scenario.ctx());
            task::post_task(
                string::utf8(b"echo"),
                string::utf8(b"general"),
                b"input-blob",
                b"agreement-hash",
                payment,
                DISPUTE_WINDOW_MS,
                EXPIRY_HOURS,
                test_clock,
                scenario.ctx(),
            );
            let events = event::events_by_type<TaskPosted>();
            task::posted_event_task_id(events.borrow(events.length() - 1))
        }
    }

    fun accept_task(scenario: &mut ts::Scenario, task_id: ID, test_clock: &Clock) {
        scenario.next_tx(PROVIDER);
        {
            let mut task_obj = scenario.take_shared_by_id<Task>(task_id);
            task::accept_task(&mut task_obj, test_clock, scenario.ctx());
            ts::return_shared(task_obj);
        }
    }

    #[test]
    fun test_deposit_agent_stake_success() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let stake_id = deposit_stake_for_owner(&mut scenario, REQUESTER, TEN_SUI, staking::agent_stake_type(), &test_clock);

        scenario.next_tx(OUTSIDER);
        {
            let position = scenario.take_shared_by_id<StakePosition>(stake_id);
            assert!(staking::stake_owner(&position) == REQUESTER);
            assert!(staking::stake_type(&position) == staking::agent_stake_type());
            assert!(staking::get_stake_amount(&position) == TEN_SUI);
            assert!(staking::is_active(&position));
            assert!(staking::meets_minimum(&position));
            ts::return_shared(position);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 1)]
    fun test_deposit_below_minimum_fails() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);

        scenario.next_tx(REQUESTER);
        {
            let payment = coin::mint_for_testing<SUI>(FIVE_SUI, scenario.ctx());
            staking::deposit_stake(payment, staking::agent_stake_type(), &test_clock, scenario.ctx());
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_deposit_relay_stake_success() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let stake_id = deposit_stake_for_owner(&mut scenario, REQUESTER, HUNDRED_SUI, staking::relay_stake_type(), &test_clock);

        scenario.next_tx(OUTSIDER);
        {
            let position = scenario.take_shared_by_id<StakePosition>(stake_id);
            assert!(staking::stake_type(&position) == staking::relay_stake_type());
            assert!(staking::get_stake_amount(&position) == HUNDRED_SUI);
            assert!(staking::meets_minimum(&position));
            ts::return_shared(position);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_add_stake_to_existing_position() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let stake_id = deposit_stake_for_owner(&mut scenario, REQUESTER, TEN_SUI, staking::agent_stake_type(), &test_clock);

        scenario.next_tx(REQUESTER);
        {
            let mut position = scenario.take_shared_by_id<StakePosition>(stake_id);
            let payment = coin::mint_for_testing<SUI>(FIVE_SUI, scenario.ctx());
            staking::add_stake(&mut position, payment, scenario.ctx());
            assert!(staking::get_stake_amount(&position) == FIFTEEN_SUI);
            ts::return_shared(position);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_start_deactivation_starts_cooldown() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let stake_id = deposit_stake_for_owner(&mut scenario, REQUESTER, TEN_SUI, staking::agent_stake_type(), &test_clock);

        scenario.next_tx(REQUESTER);
        {
            let mut position = scenario.take_shared_by_id<StakePosition>(stake_id);
            staking::start_deactivation(&mut position, &test_clock, scenario.ctx());
            assert!(staking::stake_deactivated_at(&position) == 1_000);
            assert!(staking::cooldown_remaining(&position, &test_clock) == staking::cooldown_ms());
            assert!(!staking::is_active(&position));
            ts::return_shared(position);
        };

        let deactivation_events = event::events_by_type<DeactivationStarted>();
        assert!(staking::deactivation_event_stake_id(deactivation_events.borrow(deactivation_events.length() - 1)) == stake_id);

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 3)]
    fun test_withdraw_before_cooldown_fails() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let stake_id = deposit_stake_for_owner(&mut scenario, REQUESTER, TEN_SUI, staking::agent_stake_type(), &test_clock);

        scenario.next_tx(REQUESTER);
        {
            let mut position = scenario.take_shared_by_id<StakePosition>(stake_id);
            staking::start_deactivation(&mut position, &test_clock, scenario.ctx());
            ts::return_shared(position);
        };

        scenario.next_tx(REQUESTER);
        {
            let position = scenario.take_shared_by_id<StakePosition>(stake_id);
            staking::withdraw_stake(position, &test_clock, scenario.ctx());
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_withdraw_after_cooldown_returns_sui() {
        let mut scenario = ts::begin(REQUESTER);
        let mut test_clock = create_clock(&mut scenario);
        let stake_id = deposit_stake_for_owner(&mut scenario, REQUESTER, TEN_SUI, staking::agent_stake_type(), &test_clock);

        scenario.next_tx(REQUESTER);
        {
            let mut position = scenario.take_shared_by_id<StakePosition>(stake_id);
            staking::start_deactivation(&mut position, &test_clock, scenario.ctx());
            ts::return_shared(position);
        };

        clock::set_for_testing(&mut test_clock, 1_000 + staking::cooldown_ms() + 1);
        scenario.next_tx(REQUESTER);
        {
            let position = scenario.take_shared_by_id<StakePosition>(stake_id);
            staking::withdraw_stake(position, &test_clock, scenario.ctx());
        };

        let withdraw_events = event::events_by_type<StakeWithdrawn>();
        assert!(staking::withdrawn_event_amount(withdraw_events.borrow(withdraw_events.length() - 1)) == TEN_SUI);

        scenario.next_tx(REQUESTER);
        {
            let returned = scenario.take_from_sender<coin::Coin<SUI>>();
            assert!(coin::value(&returned) == TEN_SUI);
            scenario.return_to_sender(returned);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_slash_expired_escrow_succeeds() {
        let mut scenario = ts::begin(REQUESTER);
        let mut test_clock = create_clock(&mut scenario);
        let stake_id = deposit_stake_for_owner(&mut scenario, PROVIDER, TEN_SUI, staking::agent_stake_type(), &test_clock);
        let task_id = post_default_task(&mut scenario, &test_clock, ONE_SUI);
        accept_task(&mut scenario, task_id, &test_clock);
        clock::set_for_testing(&mut test_clock, 1_000 + 3_600_000 + 1);

        scenario.next_tx(REQUESTER);
        {
            let mut position = scenario.take_shared_by_id<StakePosition>(stake_id);
            let task_obj = scenario.take_shared_by_id<Task>(task_id);
            staking::slash_expired_escrow(&mut position, &task_obj, &test_clock, scenario.ctx());
            assert!(staking::get_stake_amount(&position) == NINE_SUI());
            ts::return_shared(position);
            ts::return_shared(task_obj);
        };

        let slash_events = event::events_by_type<StakeSlashed>();
        assert!(staking::slashed_event_evidence_type(slash_events.borrow(slash_events.length() - 1)) == staking::expired_escrow_evidence_type());

        scenario.next_tx(REQUESTER);
        {
            let bounty = scenario.take_from_sender<coin::Coin<SUI>>();
            assert!(coin::value(&bounty) == ONE_SUI);
            scenario.return_to_sender(bounty);
            let record = scenario.take_from_sender<SlashRecord>();
            assert!(staking::slash_record_amount(&record) == ONE_SUI);
            scenario.return_to_sender(record);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_slash_non_delivery_succeeds() {
        let mut scenario = ts::begin(REQUESTER);
        let mut test_clock = create_clock(&mut scenario);
        let stake_id = deposit_stake_for_owner(&mut scenario, PROVIDER, TEN_SUI, staking::agent_stake_type(), &test_clock);
        let task_id = post_default_task(&mut scenario, &test_clock, ONE_SUI);
        accept_task(&mut scenario, task_id, &test_clock);
        clock::set_for_testing(&mut test_clock, 1_000 + 3_600_000 + 1);

        scenario.next_tx(REQUESTER);
        {
            let mut position = scenario.take_shared_by_id<StakePosition>(stake_id);
            let task_obj = scenario.take_shared_by_id<Task>(task_id);
            staking::slash_non_delivery(&mut position, &task_obj, &test_clock, scenario.ctx());
            assert!(staking::stake_slashed_amount(&position) == ONE_SUI);
            ts::return_shared(position);
            ts::return_shared(task_obj);
        };

        let slash_events = event::events_by_type<StakeSlashed>();
        assert!(staking::slashed_event_evidence_type(slash_events.borrow(slash_events.length() - 1)) == staking::non_delivery_evidence_type());

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 7)]
    fun test_cannot_slash_same_task_twice() {
        let mut scenario = ts::begin(REQUESTER);
        let mut test_clock = create_clock(&mut scenario);
        let stake_id = deposit_stake_for_owner(&mut scenario, PROVIDER, TEN_SUI, staking::agent_stake_type(), &test_clock);
        let task_id = post_default_task(&mut scenario, &test_clock, ONE_SUI);
        accept_task(&mut scenario, task_id, &test_clock);
        clock::set_for_testing(&mut test_clock, 1_000 + 3_600_000 + 1);

        scenario.next_tx(REQUESTER);
        {
            let mut position = scenario.take_shared_by_id<StakePosition>(stake_id);
            let task_obj = scenario.take_shared_by_id<Task>(task_id);
            staking::slash_expired_escrow(&mut position, &task_obj, &test_clock, scenario.ctx());
            ts::return_shared(position);
            ts::return_shared(task_obj);
        };

        scenario.next_tx(REQUESTER);
        {
            let mut position = scenario.take_shared_by_id<StakePosition>(stake_id);
            let task_obj = scenario.take_shared_by_id<Task>(task_id);
            staking::slash_non_delivery(&mut position, &task_obj, &test_clock, scenario.ctx());
            ts::return_shared(position);
            ts::return_shared(task_obj);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 9)]
    fun test_outsider_cannot_slash_stake() {
        let mut scenario = ts::begin(REQUESTER);
        let mut test_clock = create_clock(&mut scenario);
        let stake_id = deposit_stake_for_owner(&mut scenario, PROVIDER, TEN_SUI, staking::agent_stake_type(), &test_clock);
        let task_id = post_default_task(&mut scenario, &test_clock, ONE_SUI);
        accept_task(&mut scenario, task_id, &test_clock);
        clock::set_for_testing(&mut test_clock, 1_000 + 3_600_000 + 1);

        scenario.next_tx(OUTSIDER);
        {
            let mut position = scenario.take_shared_by_id<StakePosition>(stake_id);
            let task_obj = scenario.take_shared_by_id<Task>(task_id);
            staking::slash_expired_escrow(&mut position, &task_obj, &test_clock, scenario.ctx());
            ts::return_shared(position);
            ts::return_shared(task_obj);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_slash_amount_is_capped_by_balance() {
        let mut scenario = ts::begin(REQUESTER);
        let mut test_clock = create_clock(&mut scenario);
        let stake_id = deposit_stake_for_owner(&mut scenario, PROVIDER, TEN_SUI, staking::agent_stake_type(), &test_clock);
        let task_id = post_default_task(&mut scenario, &test_clock, TWENTY_SUI);
        accept_task(&mut scenario, task_id, &test_clock);
        clock::set_for_testing(&mut test_clock, 1_000 + 3_600_000 + 1);

        scenario.next_tx(REQUESTER);
        {
            let mut position = scenario.take_shared_by_id<StakePosition>(stake_id);
            let task_obj = scenario.take_shared_by_id<Task>(task_id);
            staking::slash_expired_escrow(&mut position, &task_obj, &test_clock, scenario.ctx());
            assert!(staking::get_stake_amount(&position) == 0);
            assert!(staking::stake_slashed_amount(&position) == TEN_SUI);
            ts::return_shared(position);
            ts::return_shared(task_obj);
        };

        scenario.next_tx(REQUESTER);
        {
            let bounty = scenario.take_from_sender<coin::Coin<SUI>>();
            assert!(coin::value(&bounty) == TEN_SUI);
            scenario.return_to_sender(bounty);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 6)]
    fun test_cannot_slash_active_task() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let stake_id = deposit_stake_for_owner(&mut scenario, PROVIDER, TEN_SUI, staking::agent_stake_type(), &test_clock);
        let task_id = post_default_task(&mut scenario, &test_clock, ONE_SUI);
        accept_task(&mut scenario, task_id, &test_clock);

        scenario.next_tx(REQUESTER);
        {
            let mut position = scenario.take_shared_by_id<StakePosition>(stake_id);
            let task_obj = scenario.take_shared_by_id<Task>(task_id);
            staking::slash_expired_escrow(&mut position, &task_obj, &test_clock, scenario.ctx());
            ts::return_shared(position);
            ts::return_shared(task_obj);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    fun NINE_SUI(): u64 {
        TEN_SUI - ONE_SUI
    }
}
