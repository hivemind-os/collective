#[test_only]
module agentic_mesh::dispute_tests {
    use agentic_mesh::dispute::{
        Self as dispute,
        Dispute,
        DisputeArbitrated,
        DisputeExpired,
        DisputeMutuallyResolved,
        DisputeOpened,
        DisputeResponded,
    };
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
    const ARBITRATOR: address = @0xD;

    const ONE_SUI: u64 = 1_000_000_000;
    const HALF_SUI: u64 = 500_000_000;
    const TWO_HUNDRED_MILLION: u64 = 200_000_000;
    const THREE_HUNDRED_MILLION: u64 = 300_000_000;
    const EIGHT_HUNDRED_MILLION: u64 = 800_000_000;
    const DISPUTE_WINDOW_MS: u64 = 60_000;
    const RESOLUTION_PERIOD_MS: u64 = 604_800_000;

    fun create_clock(scenario: &mut ts::Scenario): Clock {
        let mut test_clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut test_clock, 1_000);
        test_clock
    }

    fun post_default_task(scenario: &mut ts::Scenario, test_clock: &Clock): ID {
        scenario.next_tx(REQUESTER);
        {
            let payment = coin::mint_for_testing<SUI>(ONE_SUI, scenario.ctx());
            task::post_task(
                string::utf8(b"echo"),
                string::utf8(b"general"),
                b"input-blob",
                b"agreement-hash",
                payment,
                DISPUTE_WINDOW_MS,
                1,
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

    fun complete_task(scenario: &mut ts::Scenario, task_id: ID, test_clock: &Clock) {
        scenario.next_tx(PROVIDER);
        {
            let mut task_obj = scenario.take_shared_by_id<Task>(task_id);
            task::complete_task(&mut task_obj, b"result-blob", test_clock, scenario.ctx());
            ts::return_shared(task_obj);
        }
    }

    fun open_dispute(
        scenario: &mut ts::Scenario,
        sender: address,
        task_id: ID,
        proposed_split: u64,
        arbitrator: address,
        test_clock: &Clock,
    ): ID {
        scenario.next_tx(sender);
        {
            let mut task_obj = scenario.take_shared_by_id<Task>(task_id);
            dispute::open_dispute(
                &mut task_obj,
                b"requester-evidence",
                proposed_split,
                arbitrator,
                test_clock,
                scenario.ctx(),
            );
            ts::return_shared(task_obj);
            let events = event::events_by_type<DisputeOpened>();
            dispute::opened_event_dispute_id(events.borrow(events.length() - 1))
        }
    }

    fun respond_to_dispute(
        scenario: &mut ts::Scenario,
        sender: address,
        dispute_id: ID,
        proposed_split: u64,
        test_clock: &Clock,
    ) {
        scenario.next_tx(sender);
        {
            let mut dispute_obj = scenario.take_shared_by_id<Dispute>(dispute_id);
            dispute::respond_to_dispute(
                &mut dispute_obj,
                b"provider-evidence",
                proposed_split,
                test_clock,
                scenario.ctx(),
            );
            ts::return_shared(dispute_obj);
        }
    }

    #[test]
    fun test_open_dispute_within_window_succeeds() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &test_clock);
        accept_task(&mut scenario, task_id, &test_clock);
        complete_task(&mut scenario, task_id, &test_clock);

        let dispute_id = open_dispute(&mut scenario, REQUESTER, task_id, HALF_SUI, @0x0, &test_clock);

        scenario.next_tx(OUTSIDER);
        {
            let dispute_obj = scenario.take_shared_by_id<Dispute>(dispute_id);
            let task_obj = scenario.take_shared_by_id<Task>(task_id);
            assert!(dispute::dispute_task_id(&dispute_obj) == task_id);
            assert!(dispute::dispute_requester(&dispute_obj) == REQUESTER);
            assert!(dispute::dispute_provider(&dispute_obj) == PROVIDER);
            assert!(dispute::dispute_status(&dispute_obj) == dispute::status_open());
            assert!(dispute::dispute_requester_evidence_blob(&dispute_obj) == b"requester-evidence");
            assert!(dispute::dispute_requester_proposed_split(&dispute_obj) == HALF_SUI);
            assert!(dispute::dispute_escrow_amount(&dispute_obj) == ONE_SUI);
            assert!(task::task_status(&task_obj) == task::status_disputed());
            assert!(task::task_escrow_value(&task_obj) == ONE_SUI);
            ts::return_shared(dispute_obj);
            ts::return_shared(task_obj);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 4)]
    fun test_open_dispute_after_window_fails() {
        let mut scenario = ts::begin(REQUESTER);
        let mut test_clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &test_clock);
        accept_task(&mut scenario, task_id, &test_clock);
        complete_task(&mut scenario, task_id, &test_clock);
        clock::set_for_testing(&mut test_clock, 1_000 + DISPUTE_WINDOW_MS + 1);

        let _dispute_id = open_dispute(&mut scenario, REQUESTER, task_id, HALF_SUI, @0x0, &test_clock);

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 3)]
    fun test_open_dispute_on_non_completed_task_fails() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &test_clock);

        let _dispute_id = open_dispute(&mut scenario, REQUESTER, task_id, HALF_SUI, @0x0, &test_clock);

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 4)]
    fun test_zero_dispute_window_rejects_open_dispute() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);

        scenario.next_tx(REQUESTER);
        let task_id = {
            let payment = coin::mint_for_testing<SUI>(ONE_SUI, scenario.ctx());
            task::post_task(
                string::utf8(b"echo"),
                string::utf8(b"general"),
                b"input-blob",
                b"agreement-hash",
                payment,
                0,
                1,
                &test_clock,
                scenario.ctx(),
            );
            let events = event::events_by_type<TaskPosted>();
            task::posted_event_task_id(events.borrow(events.length() - 1))
        };

        accept_task(&mut scenario, task_id, &test_clock);
        complete_task(&mut scenario, task_id, &test_clock);
        let _dispute_id = open_dispute(&mut scenario, REQUESTER, task_id, HALF_SUI, @0x0, &test_clock);

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_provider_responds_with_evidence() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &test_clock);
        accept_task(&mut scenario, task_id, &test_clock);
        complete_task(&mut scenario, task_id, &test_clock);
        let dispute_id = open_dispute(&mut scenario, REQUESTER, task_id, EIGHT_HUNDRED_MILLION, @0x0, &test_clock);

        respond_to_dispute(&mut scenario, PROVIDER, dispute_id, TWO_HUNDRED_MILLION, &test_clock);

        scenario.next_tx(OUTSIDER);
        {
            let dispute_obj = scenario.take_shared_by_id<Dispute>(dispute_id);
            assert!(dispute::dispute_status(&dispute_obj) == dispute::status_responded());
            assert!(dispute::dispute_provider_evidence_blob(&dispute_obj) == b"provider-evidence");
            assert!(dispute::dispute_provider_proposed_split(&dispute_obj) == TWO_HUNDRED_MILLION);
            assert!(dispute::dispute_responded_at(&dispute_obj) == 1_000);
            ts::return_shared(dispute_obj);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_mutual_resolution_same_split_splits_funds() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &test_clock);
        accept_task(&mut scenario, task_id, &test_clock);
        complete_task(&mut scenario, task_id, &test_clock);
        let dispute_id = open_dispute(&mut scenario, REQUESTER, task_id, HALF_SUI, @0x0, &test_clock);
        respond_to_dispute(&mut scenario, PROVIDER, dispute_id, HALF_SUI, &test_clock);

        scenario.next_tx(REQUESTER);
        {
            let mut dispute_obj = scenario.take_shared_by_id<Dispute>(dispute_id);
            let mut task_obj = scenario.take_shared_by_id<Task>(task_id);
            dispute::accept_resolution(&mut dispute_obj, &mut task_obj, &test_clock, scenario.ctx());
            assert!(dispute::dispute_status(&dispute_obj) == dispute::status_mutual_resolved());
            assert!(task::task_status(&task_obj) == task::status_released());
            assert!(task::task_escrow_value(&task_obj) == 0);
            ts::return_shared(dispute_obj);
            ts::return_shared(task_obj);
        };

        let events = event::events_by_type<DisputeMutuallyResolved>();
        let resolved = events.borrow(events.length() - 1);
        assert!(dispute::mutual_resolved_event_requester_amount(resolved) == HALF_SUI);
        assert!(dispute::mutual_resolved_event_provider_amount(resolved) == HALF_SUI);

        scenario.next_tx(REQUESTER);
        {
            let refund = scenario.take_from_sender<coin::Coin<SUI>>();
            assert!(coin::value(&refund) == HALF_SUI);
            scenario.return_to_sender(refund);
        };

        scenario.next_tx(PROVIDER);
        {
            let payout = scenario.take_from_sender<coin::Coin<SUI>>();
            assert!(coin::value(&payout) == HALF_SUI);
            scenario.return_to_sender(payout);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_mutual_resolution_waits_until_acceptance() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &test_clock);
        accept_task(&mut scenario, task_id, &test_clock);
        complete_task(&mut scenario, task_id, &test_clock);
        let dispute_id = open_dispute(&mut scenario, REQUESTER, task_id, EIGHT_HUNDRED_MILLION, @0x0, &test_clock);
        respond_to_dispute(&mut scenario, PROVIDER, dispute_id, TWO_HUNDRED_MILLION, &test_clock);

        scenario.next_tx(OUTSIDER);
        {
            let dispute_obj = scenario.take_shared_by_id<Dispute>(dispute_id);
            let task_obj = scenario.take_shared_by_id<Task>(task_id);
            assert!(dispute::dispute_status(&dispute_obj) == dispute::status_responded());
            assert!(task::task_status(&task_obj) == task::status_disputed());
            assert!(task::task_escrow_value(&task_obj) == ONE_SUI);
            ts::return_shared(dispute_obj);
            ts::return_shared(task_obj);
        };

        scenario.next_tx(REQUESTER);
        {
            let mut dispute_obj = scenario.take_shared_by_id<Dispute>(dispute_id);
            let mut task_obj = scenario.take_shared_by_id<Task>(task_id);
            dispute::accept_resolution(&mut dispute_obj, &mut task_obj, &test_clock, scenario.ctx());
            assert!(dispute::dispute_requester_proposed_split(&dispute_obj) == TWO_HUNDRED_MILLION);
            assert!(dispute::dispute_status(&dispute_obj) == dispute::status_mutual_resolved());
            ts::return_shared(dispute_obj);
            ts::return_shared(task_obj);
        };

        scenario.next_tx(REQUESTER);
        {
            let refund = scenario.take_from_sender<coin::Coin<SUI>>();
            assert!(coin::value(&refund) == TWO_HUNDRED_MILLION);
            scenario.return_to_sender(refund);
        };

        scenario.next_tx(PROVIDER);
        {
            let payout = scenario.take_from_sender<coin::Coin<SUI>>();
            assert!(coin::value(&payout) == EIGHT_HUNDRED_MILLION);
            scenario.return_to_sender(payout);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_arbitrator_rules_on_dispute() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &test_clock);
        accept_task(&mut scenario, task_id, &test_clock);
        complete_task(&mut scenario, task_id, &test_clock);
        let dispute_id = open_dispute(&mut scenario, REQUESTER, task_id, EIGHT_HUNDRED_MILLION, ARBITRATOR, &test_clock);
        respond_to_dispute(&mut scenario, PROVIDER, dispute_id, TWO_HUNDRED_MILLION, &test_clock);

        scenario.next_tx(ARBITRATOR);
        {
            let mut dispute_obj = scenario.take_shared_by_id<Dispute>(dispute_id);
            let mut task_obj = scenario.take_shared_by_id<Task>(task_id);
            dispute::arbitrate(&mut dispute_obj, &mut task_obj, THREE_HUNDRED_MILLION, &test_clock, scenario.ctx());
            assert!(dispute::dispute_status(&dispute_obj) == dispute::status_arbitrated());
            assert!(dispute::dispute_ruling_split(&dispute_obj) == THREE_HUNDRED_MILLION);
            assert!(task::task_status(&task_obj) == task::status_released());
            ts::return_shared(dispute_obj);
            ts::return_shared(task_obj);
        };

        let events = event::events_by_type<DisputeArbitrated>();
        let ruling = events.borrow(events.length() - 1);
        assert!(dispute::arbitrated_event_arbitrator(ruling) == ARBITRATOR);
        assert!(dispute::arbitrated_event_requester_amount(ruling) == THREE_HUNDRED_MILLION);
        assert!(dispute::arbitrated_event_provider_amount(ruling) == ONE_SUI - THREE_HUNDRED_MILLION);

        scenario.next_tx(REQUESTER);
        {
            let refund = scenario.take_from_sender<coin::Coin<SUI>>();
            assert!(coin::value(&refund) == THREE_HUNDRED_MILLION);
            scenario.return_to_sender(refund);
        };

        scenario.next_tx(PROVIDER);
        {
            let payout = scenario.take_from_sender<coin::Coin<SUI>>();
            assert!(coin::value(&payout) == ONE_SUI - THREE_HUNDRED_MILLION);
            scenario.return_to_sender(payout);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_dispute_expires_to_provider() {
        let mut scenario = ts::begin(REQUESTER);
        let mut test_clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &test_clock);
        accept_task(&mut scenario, task_id, &test_clock);
        complete_task(&mut scenario, task_id, &test_clock);
        let dispute_id = open_dispute(&mut scenario, REQUESTER, task_id, HALF_SUI, @0x0, &test_clock);
        clock::set_for_testing(&mut test_clock, 1_000 + RESOLUTION_PERIOD_MS + 1);

        scenario.next_tx(OUTSIDER);
        {
            let mut dispute_obj = scenario.take_shared_by_id<Dispute>(dispute_id);
            let mut task_obj = scenario.take_shared_by_id<Task>(task_id);
            dispute::expire_dispute(&mut dispute_obj, &mut task_obj, &test_clock, scenario.ctx());
            assert!(dispute::dispute_status(&dispute_obj) == dispute::status_expired());
            assert!(task::task_status(&task_obj) == task::status_released());
            ts::return_shared(dispute_obj);
            ts::return_shared(task_obj);
        };

        let events = event::events_by_type<DisputeExpired>();
        assert!(dispute::expired_event_dispute_id(events.borrow(events.length() - 1)) == dispute_id);

        scenario.next_tx(PROVIDER);
        {
            let payout = scenario.take_from_sender<coin::Coin<SUI>>();
            assert!(coin::value(&payout) == ONE_SUI);
            scenario.return_to_sender(payout);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 5)]
    fun test_cannot_open_two_disputes_for_same_task() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &test_clock);
        accept_task(&mut scenario, task_id, &test_clock);
        complete_task(&mut scenario, task_id, &test_clock);
        let _dispute_id = open_dispute(&mut scenario, REQUESTER, task_id, HALF_SUI, @0x0, &test_clock);

        let _second_dispute_id = open_dispute(&mut scenario, REQUESTER, task_id, HALF_SUI, @0x0, &test_clock);

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_full_escrow_to_requester() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &test_clock);
        accept_task(&mut scenario, task_id, &test_clock);
        complete_task(&mut scenario, task_id, &test_clock);
        let dispute_id = open_dispute(&mut scenario, REQUESTER, task_id, ONE_SUI, @0x0, &test_clock);

        scenario.next_tx(PROVIDER);
        {
            let mut dispute_obj = scenario.take_shared_by_id<Dispute>(dispute_id);
            let mut task_obj = scenario.take_shared_by_id<Task>(task_id);
            dispute::accept_resolution(&mut dispute_obj, &mut task_obj, &test_clock, scenario.ctx());
            ts::return_shared(dispute_obj);
            ts::return_shared(task_obj);
        };

        scenario.next_tx(REQUESTER);
        {
            let refund = scenario.take_from_sender<coin::Coin<SUI>>();
            assert!(coin::value(&refund) == ONE_SUI);
            scenario.return_to_sender(refund);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_full_escrow_to_provider() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &test_clock);
        accept_task(&mut scenario, task_id, &test_clock);
        complete_task(&mut scenario, task_id, &test_clock);
        let dispute_id = open_dispute(&mut scenario, REQUESTER, task_id, 0, @0x0, &test_clock);

        scenario.next_tx(PROVIDER);
        {
            let mut dispute_obj = scenario.take_shared_by_id<Dispute>(dispute_id);
            let mut task_obj = scenario.take_shared_by_id<Task>(task_id);
            dispute::accept_resolution(&mut dispute_obj, &mut task_obj, &test_clock, scenario.ctx());
            ts::return_shared(dispute_obj);
            ts::return_shared(task_obj);
        };

        scenario.next_tx(PROVIDER);
        {
            let payout = scenario.take_from_sender<coin::Coin<SUI>>();
            assert!(coin::value(&payout) == ONE_SUI);
            scenario.return_to_sender(payout);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 1)]
    fun test_non_requester_cannot_open_dispute() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &test_clock);
        accept_task(&mut scenario, task_id, &test_clock);
        complete_task(&mut scenario, task_id, &test_clock);

        let _dispute_id = open_dispute(&mut scenario, PROVIDER, task_id, HALF_SUI, @0x0, &test_clock);

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 2)]
    fun test_non_provider_cannot_respond() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &test_clock);
        accept_task(&mut scenario, task_id, &test_clock);
        complete_task(&mut scenario, task_id, &test_clock);
        let dispute_id = open_dispute(&mut scenario, REQUESTER, task_id, HALF_SUI, @0x0, &test_clock);

        respond_to_dispute(&mut scenario, OUTSIDER, dispute_id, HALF_SUI, &test_clock);

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 9)]
    fun test_non_arbitrator_cannot_rule() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &test_clock);
        accept_task(&mut scenario, task_id, &test_clock);
        complete_task(&mut scenario, task_id, &test_clock);
        let dispute_id = open_dispute(&mut scenario, REQUESTER, task_id, HALF_SUI, ARBITRATOR, &test_clock);
        respond_to_dispute(&mut scenario, PROVIDER, dispute_id, HALF_SUI, &test_clock);

        scenario.next_tx(OUTSIDER);
        {
            let mut dispute_obj = scenario.take_shared_by_id<Dispute>(dispute_id);
            let mut task_obj = scenario.take_shared_by_id<Task>(task_id);
            dispute::arbitrate(&mut dispute_obj, &mut task_obj, HALF_SUI, &test_clock, scenario.ctx());
            ts::return_shared(dispute_obj);
            ts::return_shared(task_obj);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }
}
