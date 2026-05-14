#[test_only]
module agentic_mesh::task_tests {
    use agentic_mesh::task::{
        Self,
        Task,
        TaskAccepted,
        TaskCancelled,
        TaskCompleted,
        TaskDisputed,
        TaskExpiredRefunded,
        TaskPaymentReleased,
        TaskPosted,
    };
    use std::string::{Self, String};
    use sui::clock::{Self, Clock};
    use sui::coin;
    use sui::event;
    use sui::sui::SUI;
    use sui::test_scenario::{Self as ts};

    const REQUESTER: address = @0xA;
    const PROVIDER: address = @0xB;
    const OUTSIDER: address = @0xC;

    const ONE_SUI: u64 = 1_000_000_000;
    const TWO_SUI: u64 = 2_000_000_000;
    const DISPUTE_WINDOW_MS: u64 = 3_600_000;
    const EXPIRY_HOURS: u64 = 1;

    fun create_clock(scenario: &mut ts::Scenario): Clock {
        let mut clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut clock, 1_000);
        clock
    }

    fun post_task_with_values(
        scenario: &mut ts::Scenario,
        requester: address,
        clock: &Clock,
        capability: String,
        input_blob_id: vector<u8>,
        agreement_hash: vector<u8>,
        amount: u64,
        dispute_window_ms: u64,
        expiry_hours: u64,
    ): ID {
        scenario.next_tx(requester);
        {
            let payment = coin::mint_for_testing<SUI>(amount, scenario.ctx());
            task::post_task(
                capability,
                input_blob_id,
                agreement_hash,
                payment,
                dispute_window_ms,
                expiry_hours,
                clock,
                scenario.ctx(),
            );
            let events = event::events_by_type<TaskPosted>();
            assert!(events.length() == 1);
            task::posted_event_task_id(events.borrow(0))
        }
    }

    fun post_default_task(scenario: &mut ts::Scenario, clock: &Clock): ID {
        post_task_with_values(
            scenario,
            REQUESTER,
            clock,
            string::utf8(b"text-generation"),
            b"input-blob-id",
            b"agreement-hash",
            ONE_SUI,
            DISPUTE_WINDOW_MS,
            EXPIRY_HOURS,
        )
    }

    fun accept_task_by_id(
        scenario: &mut ts::Scenario,
        provider: address,
        task_id: ID,
        clock: &Clock,
    ) {
        scenario.next_tx(provider);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::accept_task(&mut t, clock, scenario.ctx());
            ts::return_shared(t);
        }
    }

    fun complete_task_by_id(
        scenario: &mut ts::Scenario,
        provider: address,
        task_id: ID,
        result_blob_id: vector<u8>,
        clock: &Clock,
    ) {
        scenario.next_tx(provider);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::complete_task(&mut t, result_blob_id, clock, scenario.ctx());
            ts::return_shared(t);
        }
    }

    #[test]
    fun test_post_task_with_escrow() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);

        let task_id = post_default_task(&mut scenario, &clock);

        scenario.next_tx(OUTSIDER);
        {
            let t = scenario.take_shared_by_id<Task>(task_id);
            assert!(task::task_requester(&t) == REQUESTER);
            assert!(task::task_provider(&t) == @0x0);
            assert!(task::task_capability(&t) == string::utf8(b"text-generation"));
            assert!(task::task_input_blob_id(&t) == b"input-blob-id");
            assert!(task::task_agreement_hash(&t) == b"agreement-hash");
            assert!(task::task_price(&t) == ONE_SUI);
            assert!(task::task_escrow_value(&t) == ONE_SUI);
            assert!(task::task_status(&t) == task::status_open());
            assert!(task::task_expires_at(&t) == 1_000 + DISPUTE_WINDOW_MS);
            assert!(task::task_created_at(&t) == 1_000);
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_accept_task() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);

        accept_task_by_id(&mut scenario, PROVIDER, task_id, &clock);

        scenario.next_tx(OUTSIDER);
        {
            let t = scenario.take_shared_by_id<Task>(task_id);
            assert!(task::task_status(&t) == task::status_accepted());
            assert!(task::task_provider(&t) == PROVIDER);
            assert!(task::task_accepted_at(&t) == 1_000);
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_complete_task() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);

        accept_task_by_id(&mut scenario, PROVIDER, task_id, &clock);
        complete_task_by_id(&mut scenario, PROVIDER, task_id, b"result-blob-id", &clock);

        scenario.next_tx(OUTSIDER);
        {
            let t = scenario.take_shared_by_id<Task>(task_id);
            assert!(task::task_status(&t) == task::status_completed());
            assert!(task::task_result_blob_id(&t) == b"result-blob-id");
            assert!(task::task_completed_at(&t) == 1_000);
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_release_payment_verifies_provider_balance() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);

        accept_task_by_id(&mut scenario, PROVIDER, task_id, &clock);
        complete_task_by_id(&mut scenario, PROVIDER, task_id, b"result", &clock);

        scenario.next_tx(REQUESTER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::release_payment(&mut t, scenario.ctx());
            assert!(task::task_status(&t) == task::status_released());
            assert!(task::task_escrow_value(&t) == 0);
            ts::return_shared(t);
        };

        scenario.next_tx(PROVIDER);
        {
            let payment = scenario.take_from_sender<coin::Coin<SUI>>();
            assert!(coin::value(&payment) == ONE_SUI);
            scenario.return_to_sender(payment);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_full_lifecycle_post_accept_complete_release() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);

        accept_task_by_id(&mut scenario, PROVIDER, task_id, &clock);
        complete_task_by_id(&mut scenario, PROVIDER, task_id, b"lifecycle-result", &clock);

        scenario.next_tx(REQUESTER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::release_payment(&mut t, scenario.ctx());
            assert!(task::task_requester(&t) == REQUESTER);
            assert!(task::task_provider(&t) == PROVIDER);
            assert!(task::task_status(&t) == task::status_released());
            assert!(task::task_result_blob_id(&t) == b"lifecycle-result");
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_claim_after_dispute_window() {
        let mut scenario = ts::begin(REQUESTER);
        let mut clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);

        accept_task_by_id(&mut scenario, PROVIDER, task_id, &clock);
        complete_task_by_id(&mut scenario, PROVIDER, task_id, b"claim-result", &clock);
        clock::set_for_testing(&mut clock, 1_000 + DISPUTE_WINDOW_MS + 1);

        scenario.next_tx(PROVIDER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::claim_payment(&mut t, &clock, scenario.ctx());
            assert!(task::task_status(&t) == task::status_released());
            assert!(task::task_escrow_value(&t) == 0);
            ts::return_shared(t);
        };

        scenario.next_tx(PROVIDER);
        {
            let payment = scenario.take_from_sender<coin::Coin<SUI>>();
            assert!(coin::value(&payment) == ONE_SUI);
            scenario.return_to_sender(payment);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 104)]
    fun test_claim_before_window_fails() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);

        accept_task_by_id(&mut scenario, PROVIDER, task_id, &clock);
        complete_task_by_id(&mut scenario, PROVIDER, task_id, b"result", &clock);

        scenario.next_tx(PROVIDER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::claim_payment(&mut t, &clock, scenario.ctx());
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_dispute_within_window() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);

        accept_task_by_id(&mut scenario, PROVIDER, task_id, &clock);
        complete_task_by_id(&mut scenario, PROVIDER, task_id, b"result", &clock);

        scenario.next_tx(REQUESTER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::dispute_task(&mut t, &clock, scenario.ctx());
            assert!(task::task_status(&t) == task::status_disputed());
            assert!(task::task_escrow_value(&t) == ONE_SUI);
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 105)]
    fun test_dispute_after_window_fails() {
        let mut scenario = ts::begin(REQUESTER);
        let mut clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);

        accept_task_by_id(&mut scenario, PROVIDER, task_id, &clock);
        complete_task_by_id(&mut scenario, PROVIDER, task_id, b"result", &clock);
        clock::set_for_testing(&mut clock, 1_000 + DISPUTE_WINDOW_MS + 1);

        scenario.next_tx(REQUESTER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::dispute_task(&mut t, &clock, scenario.ctx());
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_cancel_open_task_full_refund() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);

        scenario.next_tx(REQUESTER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::cancel_task(&mut t, scenario.ctx());
            assert!(task::task_status(&t) == task::status_cancelled());
            assert!(task::task_escrow_value(&t) == 0);
            ts::return_shared(t);
        };

        scenario.next_tx(REQUESTER);
        {
            let refund = scenario.take_from_sender<coin::Coin<SUI>>();
            assert!(coin::value(&refund) == ONE_SUI);
            scenario.return_to_sender(refund);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 100)]
    fun test_cancel_accepted_task_fails() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);
        accept_task_by_id(&mut scenario, PROVIDER, task_id, &clock);

        scenario.next_tx(REQUESTER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::cancel_task(&mut t, scenario.ctx());
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 102)]
    fun test_requester_self_accept_fails() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);

        scenario.next_tx(REQUESTER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::accept_task(&mut t, &clock, scenario.ctx());
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 102)]
    fun test_wrong_provider_complete_fails() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);
        accept_task_by_id(&mut scenario, PROVIDER, task_id, &clock);

        scenario.next_tx(OUTSIDER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::complete_task(&mut t, b"bad-result", &clock, scenario.ctx());
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 101)]
    fun test_non_requester_cancel_fails() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);

        scenario.next_tx(PROVIDER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::cancel_task(&mut t, scenario.ctx());
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 107)]
    fun test_release_before_completion_fails() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);
        accept_task_by_id(&mut scenario, PROVIDER, task_id, &clock);

        scenario.next_tx(REQUESTER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::release_payment(&mut t, scenario.ctx());
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 107)]
    fun test_double_release_fails() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);
        accept_task_by_id(&mut scenario, PROVIDER, task_id, &clock);
        complete_task_by_id(&mut scenario, PROVIDER, task_id, b"result", &clock);

        scenario.next_tx(REQUESTER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::release_payment(&mut t, scenario.ctx());
            ts::return_shared(t);
        };

        scenario.next_tx(REQUESTER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::release_payment(&mut t, scenario.ctx());
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 100)]
    fun test_double_accept_fails() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);

        accept_task_by_id(&mut scenario, PROVIDER, task_id, &clock);

        scenario.next_tx(OUTSIDER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::accept_task(&mut t, &clock, scenario.ctx());
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 108)]
    fun test_accept_expired_task_fails() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_task_with_values(
            &mut scenario,
            REQUESTER,
            &clock,
            string::utf8(b"expired-capability"),
            b"input",
            b"agreement",
            ONE_SUI,
            DISPUTE_WINDOW_MS,
            0,
        );

        scenario.next_tx(PROVIDER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::accept_task(&mut t, &clock, scenario.ctx());
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_refund_expired_task_succeeds() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_task_with_values(
            &mut scenario,
            REQUESTER,
            &clock,
            string::utf8(b"expired-capability"),
            b"input",
            b"agreement",
            ONE_SUI,
            DISPUTE_WINDOW_MS,
            0,
        );

        scenario.next_tx(OUTSIDER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::refund_expired_task(&mut t, &clock, scenario.ctx());
            assert!(task::task_status(&t) == task::status_cancelled());
            assert!(task::task_escrow_value(&t) == 0);
            ts::return_shared(t);
        };

        scenario.next_tx(REQUESTER);
        {
            let refund = scenario.take_from_sender<coin::Coin<SUI>>();
            assert!(coin::value(&refund) == ONE_SUI);
            scenario.return_to_sender(refund);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 109)]
    fun test_refund_non_expired_task_fails() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);

        scenario.next_tx(OUTSIDER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::refund_expired_task(&mut t, &clock, scenario.ctx());
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 110)]
    fun test_post_task_with_zero_payment_fails() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);

        scenario.next_tx(REQUESTER);
        {
            let payment = coin::mint_for_testing<SUI>(0, scenario.ctx());
            task::post_task(
                string::utf8(b"free-task"),
                b"input",
                b"agreement",
                payment,
                DISPUTE_WINDOW_MS,
                EXPIRY_HOURS,
                &clock,
                scenario.ctx(),
            );
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_complete_with_blob_id_stored_correctly() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);
        accept_task_by_id(&mut scenario, PROVIDER, task_id, &clock);
        complete_task_by_id(&mut scenario, PROVIDER, task_id, b"walrus-result-blob", &clock);

        scenario.next_tx(OUTSIDER);
        {
            let t = scenario.take_shared_by_id<Task>(task_id);
            assert!(task::task_result_blob_id(&t) == b"walrus-result-blob");
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 100)]
    fun test_accept_already_cancelled_fails() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);

        scenario.next_tx(REQUESTER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::cancel_task(&mut t, scenario.ctx());
            ts::return_shared(t);
        };

        scenario.next_tx(PROVIDER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::accept_task(&mut t, &clock, scenario.ctx());
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 107)]
    fun test_claim_already_released_fails() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);
        accept_task_by_id(&mut scenario, PROVIDER, task_id, &clock);
        complete_task_by_id(&mut scenario, PROVIDER, task_id, b"result", &clock);

        scenario.next_tx(REQUESTER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::release_payment(&mut t, scenario.ctx());
            ts::return_shared(t);
        };

        scenario.next_tx(PROVIDER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::claim_payment(&mut t, &clock, scenario.ctx());
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_task_events_contain_correct_fields() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);

        let task_id = {
            scenario.next_tx(REQUESTER);
            let payment = coin::mint_for_testing<SUI>(TWO_SUI, scenario.ctx());
            task::post_task(
                string::utf8(b"code-review"),
                b"input-for-events",
                b"agreement-for-events",
                payment,
                DISPUTE_WINDOW_MS,
                EXPIRY_HOURS,
                &clock,
                scenario.ctx(),
            );
            let posted = event::events_by_type<TaskPosted>();
            assert!(posted.length() == 1);
            let posted_event = posted.borrow(0);
            assert!(task::posted_event_requester(posted_event) == REQUESTER);
            assert!(task::posted_event_provider(posted_event) == @0x0);
            assert!(task::posted_event_capability(posted_event) == string::utf8(b"code-review"));
            assert!(task::posted_event_input_blob_id(posted_event) == b"input-for-events");
            assert!(task::posted_event_agreement_hash(posted_event) == b"agreement-for-events");
            assert!(task::posted_event_price(posted_event) == TWO_SUI);
            assert!(task::posted_event_status(posted_event) == task::status_open());
            assert!(task::posted_event_dispute_window_ms(posted_event) == DISPUTE_WINDOW_MS);
            assert!(task::posted_event_expires_at(posted_event) == 1_000 + DISPUTE_WINDOW_MS);
            assert!(task::posted_event_created_at(posted_event) == 1_000);
            task::posted_event_task_id(posted_event)
        };

        scenario.next_tx(PROVIDER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::accept_task(&mut t, &clock, scenario.ctx());
            let accepted = event::events_by_type<TaskAccepted>();
            assert!(accepted.length() == 1);
            let accepted_event = accepted.borrow(0);
            assert!(task::accepted_event_task_id(accepted_event) == task_id);
            assert!(task::accepted_event_provider(accepted_event) == PROVIDER);
            assert!(task::accepted_event_capability(accepted_event) == string::utf8(b"code-review"));
            assert!(task::accepted_event_price(accepted_event) == TWO_SUI);
            assert!(task::accepted_event_status(accepted_event) == task::status_accepted());
            assert!(task::accepted_event_accepted_at(accepted_event) == 1_000);
            ts::return_shared(t);
        };

        scenario.next_tx(PROVIDER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::complete_task(&mut t, b"event-result", &clock, scenario.ctx());
            let completed = event::events_by_type<TaskCompleted>();
            assert!(completed.length() == 1);
            let completed_event = completed.borrow(0);
            assert!(task::completed_event_task_id(completed_event) == task_id);
            assert!(task::completed_event_provider(completed_event) == PROVIDER);
            assert!(task::completed_event_result_blob_id(completed_event) == b"event-result");
            assert!(task::completed_event_price(completed_event) == TWO_SUI);
            assert!(task::completed_event_status(completed_event) == task::status_completed());
            assert!(task::completed_event_completed_at(completed_event) == 1_000);
            ts::return_shared(t);
        };

        scenario.next_tx(REQUESTER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::release_payment(&mut t, scenario.ctx());
            let released = event::events_by_type<TaskPaymentReleased>();
            assert!(released.length() == 1);
            let released_event = released.borrow(0);
            assert!(task::payment_released_event_task_id(released_event) == task_id);
            assert!(task::payment_released_event_provider(released_event) == PROVIDER);
            assert!(task::payment_released_event_price(released_event) == TWO_SUI);
            assert!(task::payment_released_event_status(released_event) == task::status_released());
            assert!(task::payment_released_event_released_by(released_event) == REQUESTER);
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    fun test_multiple_tasks_can_exist_simultaneously() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);

        let task_id_1 = post_task_with_values(
            &mut scenario,
            REQUESTER,
            &clock,
            string::utf8(b"text-generation"),
            b"input-1",
            b"agreement-1",
            ONE_SUI,
            DISPUTE_WINDOW_MS,
            EXPIRY_HOURS,
        );
        let task_id_2 = post_task_with_values(
            &mut scenario,
            REQUESTER,
            &clock,
            string::utf8(b"summarization"),
            b"input-2",
            b"agreement-2",
            TWO_SUI,
            DISPUTE_WINDOW_MS,
            EXPIRY_HOURS,
        );

        scenario.next_tx(PROVIDER);
        {
            let mut t1 = scenario.take_shared_by_id<Task>(task_id_1);
            task::accept_task(&mut t1, &clock, scenario.ctx());
            ts::return_shared(t1);
        };

        scenario.next_tx(OUTSIDER);
        {
            let t1 = scenario.take_shared_by_id<Task>(task_id_1);
            let t2 = scenario.take_shared_by_id<Task>(task_id_2);
            assert!(task::task_status(&t1) == task::status_accepted());
            assert!(task::task_status(&t2) == task::status_open());
            assert!(task::task_capability(&t1) == string::utf8(b"text-generation"));
            assert!(task::task_capability(&t2) == string::utf8(b"summarization"));
            assert!(task::task_price(&t1) == ONE_SUI);
            assert!(task::task_price(&t2) == TWO_SUI);
            ts::return_shared(t1);
            ts::return_shared(t2);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 107)]
    fun test_dispute_already_released_fails() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);
        accept_task_by_id(&mut scenario, PROVIDER, task_id, &clock);
        complete_task_by_id(&mut scenario, PROVIDER, task_id, b"result", &clock);

        scenario.next_tx(REQUESTER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::release_payment(&mut t, scenario.ctx());
            ts::return_shared(t);
        };

        scenario.next_tx(REQUESTER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::dispute_task(&mut t, &clock, scenario.ctx());
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }

    #[test]
    #[expected_failure(abort_code = 100)]
    fun test_refund_accepted_task_fails() {
        let mut scenario = ts::begin(REQUESTER);
        let clock = create_clock(&mut scenario);
        let task_id = post_default_task(&mut scenario, &clock);
        accept_task_by_id(&mut scenario, PROVIDER, task_id, &clock);

        scenario.next_tx(OUTSIDER);
        {
            let mut t = scenario.take_shared_by_id<Task>(task_id);
            task::refund_expired_task(&mut t, &clock, scenario.ctx());
            ts::return_shared(t);
        };

        clock::destroy_for_testing(clock);
        scenario.end();
    }
}
