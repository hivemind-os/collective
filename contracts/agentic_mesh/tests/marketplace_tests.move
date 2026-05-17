#[test_only]
module agentic_mesh::marketplace_tests {
    use agentic_mesh::marketplace::{
        Self as marketplace,
        Bid,
        BidAccepted,
        BidPlaced,
        BidRejected,
        BidWithdrawn,
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
    const ONE_SUI: u64 = 1_000_000_000;
    const HALF_SUI: u64 = 500_000_000;
    const DISPUTE_WINDOW_MS: u64 = 60_000;
    const EXPIRY_HOURS: u64 = 1;

    fun create_clock(scenario: &mut ts::Scenario): Clock {
        let mut test_clock = clock::create_for_testing(scenario.ctx());
        clock::set_for_testing(&mut test_clock, 1_000);
        test_clock
    }

    fun post_open_task(scenario: &mut ts::Scenario, test_clock: &Clock): ID {
        scenario.next_tx(REQUESTER);
        {
            let payment = coin::mint_for_testing<SUI>(ONE_SUI, scenario.ctx());
            task::post_open_task(
                string::utf8(b"code-review"),
                string::utf8(b"analysis"),
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

    fun place_bid_for_task(
        scenario: &mut ts::Scenario,
        bidder: address,
        task_id: ID,
        reputation_score: u64,
        bid_price: u64,
        test_clock: &Clock,
    ): ID {
        scenario.next_tx(bidder);
        {
            let task_obj = scenario.take_shared_by_id<Task<SUI>>(task_id);
            marketplace::place_bid(&task_obj, reputation_score, bid_price, b"proposal", test_clock, scenario.ctx());
            ts::return_shared(task_obj);
            let events = event::events_by_type<BidPlaced>();
            marketplace::placed_event_bid_id(events.borrow(events.length() - 1))
        }
    }

    #[test]
    fun test_place_bid_creates_shared_bid() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let task_id = post_open_task(&mut scenario, &test_clock);
        let bid_id = place_bid_for_task(&mut scenario, PROVIDER, task_id, 95, HALF_SUI, &test_clock);

        scenario.next_tx(REQUESTER);
        {
            let bid = scenario.take_shared_by_id<Bid>(bid_id);
            assert!(marketplace::bid_task_id(&bid) == task_id);
            assert!(marketplace::bid_bidder(&bid) == PROVIDER);
            assert!(marketplace::bid_price(&bid) == HALF_SUI);
            assert!(marketplace::bid_reputation_score(&bid) == 95);
            assert!(marketplace::bid_evidence_blob(&bid) == b"proposal");
            assert!(marketplace::bid_status(&bid) == marketplace::status_active());
            ts::return_shared(bid);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_accept_bid_updates_task_and_refunds_difference() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let task_id = post_open_task(&mut scenario, &test_clock);
        let bid_id = place_bid_for_task(&mut scenario, PROVIDER, task_id, 80, HALF_SUI, &test_clock);

        scenario.next_tx(REQUESTER);
        {
            let mut task_obj = scenario.take_shared_by_id<Task<SUI>>(task_id);
            let mut bid = scenario.take_shared_by_id<Bid>(bid_id);
            marketplace::accept_bid(&mut task_obj, &mut bid, &test_clock, scenario.ctx());
            assert!(task::task_provider(&task_obj) == PROVIDER);
            assert!(task::task_status(&task_obj) == task::status_accepted());
            assert!(task::task_price(&task_obj) == HALF_SUI);
            assert!(task::task_escrow_value(&task_obj) == HALF_SUI);
            assert!(marketplace::bid_status(&bid) == marketplace::status_accepted());
            let accepted = event::events_by_type<BidAccepted>();
            let accepted_event = accepted.borrow(accepted.length() - 1);
            assert!(marketplace::accepted_event_bid_id(accepted_event) == bid_id);
            assert!(marketplace::accepted_event_refunded_amount(accepted_event) == HALF_SUI);
            ts::return_shared(task_obj);
            ts::return_shared(bid);
        };

        scenario.next_tx(REQUESTER);
        {
            let refund = scenario.take_from_sender<coin::Coin<SUI>>();
            assert!(coin::value(&refund) == HALF_SUI);
            scenario.return_to_sender(refund);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_withdraw_bid_marks_bid_withdrawn() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let task_id = post_open_task(&mut scenario, &test_clock);
        let bid_id = place_bid_for_task(&mut scenario, PROVIDER, task_id, 40, HALF_SUI, &test_clock);

        scenario.next_tx(PROVIDER);
        {
            let mut bid = scenario.take_shared_by_id<Bid>(bid_id);
            marketplace::withdraw_bid(&mut bid, scenario.ctx());
            assert!(marketplace::bid_status(&bid) == marketplace::status_withdrawn());
            let withdrawn = event::events_by_type<BidWithdrawn>();
            assert!(marketplace::withdrawn_event_bid_id(withdrawn.borrow(withdrawn.length() - 1)) == bid_id);
            ts::return_shared(bid);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_reject_bid_marks_bid_rejected() {
        let mut scenario = ts::begin(REQUESTER);
        let test_clock = create_clock(&mut scenario);
        let task_id = post_open_task(&mut scenario, &test_clock);
        let bid_id = place_bid_for_task(&mut scenario, PROVIDER, task_id, 40, HALF_SUI, &test_clock);

        scenario.next_tx(REQUESTER);
        {
            let task_obj = scenario.take_shared_by_id<Task<SUI>>(task_id);
            let mut bid = scenario.take_shared_by_id<Bid>(bid_id);
            marketplace::reject_bid(&mut bid, &task_obj, scenario.ctx());
            assert!(marketplace::bid_status(&bid) == marketplace::status_rejected());
            let rejected = event::events_by_type<BidRejected>();
            assert!(marketplace::rejected_event_bid_id(rejected.borrow(rejected.length() - 1)) == bid_id);
            ts::return_shared(task_obj);
            ts::return_shared(bid);
        };

        clock::destroy_for_testing(test_clock);
        scenario.end();
    }

    #[test]
    fun test_selection_score_prefers_higher_reputation_and_lower_price() {
        let premium_bid_score = marketplace::selection_score(90, HALF_SUI, 1_000_000, 1);
        let discount_bid_score = marketplace::selection_score(50, ONE_SUI, 1_000_000, 1);
        let cheaper_bid_score = marketplace::selection_score(50, HALF_SUI, 1_000_000, 1);

        assert!(premium_bid_score > discount_bid_score);
        assert!(cheaper_bid_score > discount_bid_score);
    }
}
