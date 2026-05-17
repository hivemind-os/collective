module agentic_mesh::marketplace {
    use agentic_mesh::task::{Self as task, Task};
    use sui::clock::Clock;
    use sui::event;

    const STATUS_ACTIVE: u8 = 0;
    const STATUS_ACCEPTED: u8 = 1;
    const STATUS_REJECTED: u8 = 2;
    const STATUS_WITHDRAWN: u8 = 3;

    const E_INVALID_STATUS: u64 = 1;
    const E_NOT_REQUESTER: u64 = 2;
    const E_NOT_BIDDER: u64 = 3;
    const E_TASK_NOT_OPEN: u64 = 4;
    const E_TASK_EXPIRED: u64 = 5;
    const E_INVALID_BID_PRICE: u64 = 6;
    const E_TASK_MISMATCH: u64 = 7;

    public struct Bid has key, store {
        id: UID,
        task_id: ID,
        bidder: address,
        bid_price: u64,
        reputation_score: u64,
        evidence_blob: vector<u8>,
        created_at: u64,
        status: u8,
    }

    public struct BidPlaced has copy, drop {
        bid_id: ID,
        task_id: ID,
        bidder: address,
        bid_price: u64,
        reputation_score: u64,
        evidence_blob: vector<u8>,
        created_at: u64,
        status: u8,
    }

    public struct BidAccepted has copy, drop {
        bid_id: ID,
        task_id: ID,
        requester: address,
        bidder: address,
        bid_price: u64,
        refunded_amount: u64,
        accepted_at: u64,
        status: u8,
    }

    public struct BidWithdrawn has copy, drop {
        bid_id: ID,
        task_id: ID,
        bidder: address,
        status: u8,
    }

    public struct BidRejected has copy, drop {
        bid_id: ID,
        task_id: ID,
        requester: address,
        bidder: address,
        status: u8,
    }

    public fun place_bid<T>(
        task: &Task<T>,
        reputation_score: u64,
        bid_price: u64,
        evidence_blob: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(task::task_status(task) == task::status_open(), E_TASK_NOT_OPEN);
        assert!(clock.timestamp_ms() < task::task_expires_at(task), E_TASK_EXPIRED);
        assert!(ctx.sender() != task::task_requester(task), E_NOT_BIDDER);
        assert!(bid_price > 0 && bid_price <= task::task_price(task), E_INVALID_BID_PRICE);

        let bid = Bid {
            id: object::new(ctx),
            task_id: task::task_id(task),
            bidder: ctx.sender(),
            bid_price,
            reputation_score,
            evidence_blob,
            created_at: clock.timestamp_ms(),
            status: STATUS_ACTIVE,
        };

        event::emit(BidPlaced {
            bid_id: object::id(&bid),
            task_id: bid.task_id,
            bidder: bid.bidder,
            bid_price: bid.bid_price,
            reputation_score: bid.reputation_score,
            evidence_blob: bid.evidence_blob,
            created_at: bid.created_at,
            status: bid.status,
        });

        transfer::share_object(bid);
    }

    public fun accept_bid<T>(task: &mut Task<T>, bid: &mut Bid, clock: &Clock, ctx: &mut TxContext) {
        assert!(ctx.sender() == task::task_requester(task), E_NOT_REQUESTER);
        assert!(bid.task_id == task::task_id(task), E_TASK_MISMATCH);
        assert!(bid.status == STATUS_ACTIVE, E_INVALID_STATUS);

        let refunded_amount = task::accept_bid_for_task<T>(task, bid.bidder, bid.bid_price, clock, ctx);
        bid.status = STATUS_ACCEPTED;

        event::emit(BidAccepted {
            bid_id: object::id(bid),
            task_id: bid.task_id,
            requester: task::task_requester(task),
            bidder: bid.bidder,
            bid_price: bid.bid_price,
            refunded_amount,
            accepted_at: task::task_accepted_at(task),
            status: bid.status,
        });
    }

    public fun withdraw_bid(bid: &mut Bid, ctx: &TxContext) {
        assert!(ctx.sender() == bid.bidder, E_NOT_BIDDER);
        assert!(bid.status == STATUS_ACTIVE, E_INVALID_STATUS);

        bid.status = STATUS_WITHDRAWN;
        event::emit(BidWithdrawn {
            bid_id: object::id(bid),
            task_id: bid.task_id,
            bidder: bid.bidder,
            status: bid.status,
        });
    }

    public fun reject_bid<T>(bid: &mut Bid, task: &Task<T>, ctx: &TxContext) {
        assert!(ctx.sender() == task::task_requester(task), E_NOT_REQUESTER);
        assert!(bid.task_id == task::task_id(task), E_TASK_MISMATCH);
        assert!(bid.status == STATUS_ACTIVE, E_INVALID_STATUS);

        bid.status = STATUS_REJECTED;
        event::emit(BidRejected {
            bid_id: object::id(bid),
            task_id: bid.task_id,
            requester: task::task_requester(task),
            bidder: bid.bidder,
            status: bid.status,
        });
    }

    public fun selection_score(reputation_score: u64, bid_price: u64, reputation_weight: u64, price_weight: u64): u128 {
        let weighted_reputation = (reputation_score as u128) * (reputation_weight as u128) * 1_000_000;
        let weighted_price = ((bid_price as u128) * (price_weight as u128)) + 1;
        weighted_reputation / weighted_price
    }

    public fun bid_selection_score(bid: &Bid, reputation_weight: u64, price_weight: u64): u128 {
        selection_score(bid.reputation_score, bid.bid_price, reputation_weight, price_weight)
    }

    public fun bid_id(bid: &Bid): ID { object::id(bid) }
    public fun bid_task_id(bid: &Bid): ID { bid.task_id }
    public fun bid_bidder(bid: &Bid): address { bid.bidder }
    public fun bid_price(bid: &Bid): u64 { bid.bid_price }
    public fun bid_reputation_score(bid: &Bid): u64 { bid.reputation_score }
    public fun bid_evidence_blob(bid: &Bid): vector<u8> { bid.evidence_blob }
    public fun bid_created_at(bid: &Bid): u64 { bid.created_at }
    public fun bid_status(bid: &Bid): u8 { bid.status }

    public fun status_active(): u8 { STATUS_ACTIVE }
    public fun status_accepted(): u8 { STATUS_ACCEPTED }
    public fun status_rejected(): u8 { STATUS_REJECTED }
    public fun status_withdrawn(): u8 { STATUS_WITHDRAWN }

    public fun placed_event_bid_id(event: &BidPlaced): ID { event.bid_id }
    public fun placed_event_task_id(event: &BidPlaced): ID { event.task_id }
    public fun placed_event_bidder(event: &BidPlaced): address { event.bidder }
    public fun placed_event_bid_price(event: &BidPlaced): u64 { event.bid_price }
    public fun placed_event_reputation_score(event: &BidPlaced): u64 { event.reputation_score }
    public fun placed_event_status(event: &BidPlaced): u8 { event.status }

    public fun accepted_event_bid_id(event: &BidAccepted): ID { event.bid_id }
    public fun accepted_event_task_id(event: &BidAccepted): ID { event.task_id }
    public fun accepted_event_requester(event: &BidAccepted): address { event.requester }
    public fun accepted_event_bidder(event: &BidAccepted): address { event.bidder }
    public fun accepted_event_bid_price(event: &BidAccepted): u64 { event.bid_price }
    public fun accepted_event_refunded_amount(event: &BidAccepted): u64 { event.refunded_amount }
    public fun accepted_event_accepted_at(event: &BidAccepted): u64 { event.accepted_at }
    public fun accepted_event_status(event: &BidAccepted): u8 { event.status }

    public fun withdrawn_event_bid_id(event: &BidWithdrawn): ID { event.bid_id }
    public fun withdrawn_event_task_id(event: &BidWithdrawn): ID { event.task_id }
    public fun withdrawn_event_bidder(event: &BidWithdrawn): address { event.bidder }
    public fun withdrawn_event_status(event: &BidWithdrawn): u8 { event.status }

    public fun rejected_event_bid_id(event: &BidRejected): ID { event.bid_id }
    public fun rejected_event_task_id(event: &BidRejected): ID { event.task_id }
    public fun rejected_event_requester(event: &BidRejected): address { event.requester }
    public fun rejected_event_bidder(event: &BidRejected): address { event.bidder }
    public fun rejected_event_status(event: &BidRejected): u8 { event.status }
}
