module agentic_mesh::reputation {
    use agentic_mesh::registry::{Self as registry, AgentCard};
    use sui::clock::Clock;
    use sui::event;

    const MERKLE_ROOT_BYTES: u64 = 32;
    const E_INVALID_MERKLE_ROOT: u64 = 1;
    const E_INVALID_EVENT_COUNT: u64 = 2;
    const E_INVALID_BLOB_ID: u64 = 3;
    const E_INVALID_TIME_RANGE: u64 = 4;

    public struct ReputationAnchor has key, store {
        id: UID,
        author: address,
        merkle_root: vector<u8>,
        event_count: u64,
        blob_id: vector<u8>,
        from_timestamp: u64,
        to_timestamp: u64,
        created_at: u64,
    }

    public struct AnchorPublished has copy, drop {
        anchor_id: ID,
        author: address,
        merkle_root: vector<u8>,
        event_count: u64,
    }

    public fun publish_anchor(
        merkle_root: vector<u8>,
        event_count: u64,
        blob_id: vector<u8>,
        from_timestamp: u64,
        to_timestamp: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(merkle_root.length() == MERKLE_ROOT_BYTES, E_INVALID_MERKLE_ROOT);
        assert!(event_count > 0, E_INVALID_EVENT_COUNT);
        assert!(blob_id.length() > 0, E_INVALID_BLOB_ID);
        assert!(from_timestamp <= to_timestamp, E_INVALID_TIME_RANGE);

        let anchor = ReputationAnchor {
            id: object::new(ctx),
            author: ctx.sender(),
            merkle_root,
            event_count,
            blob_id,
            from_timestamp,
            to_timestamp,
            created_at: clock.timestamp_ms(),
        };

        event::emit(AnchorPublished {
            anchor_id: object::id(&anchor),
            author: anchor.author,
            merkle_root: anchor.merkle_root,
            event_count: anchor.event_count,
        });

        transfer::transfer(anchor, ctx.sender());
    }

    public(package) fun record_task_completion(card: &mut AgentCard) {
        registry::increment_completed(card);
    }

    public(package) fun record_task_failure(card: &mut AgentCard) {
        registry::increment_failed(card);
    }

    public(package) fun record_task_dispute(card: &mut AgentCard) {
        registry::increment_disputed(card);
    }

    public(package) fun record_payment(card: &mut AgentCard, amount: u64) {
        registry::add_earnings(card, amount);
    }

    public fun anchor_id(anchor: &ReputationAnchor): ID { object::id(anchor) }
    public fun anchor_author(anchor: &ReputationAnchor): address { anchor.author }
    public fun anchor_merkle_root(anchor: &ReputationAnchor): vector<u8> { anchor.merkle_root }
    public fun anchor_event_count(anchor: &ReputationAnchor): u64 { anchor.event_count }
    public fun anchor_blob_id(anchor: &ReputationAnchor): vector<u8> { anchor.blob_id }
    public fun anchor_from_timestamp(anchor: &ReputationAnchor): u64 { anchor.from_timestamp }
    public fun anchor_to_timestamp(anchor: &ReputationAnchor): u64 { anchor.to_timestamp }
    public fun anchor_created_at(anchor: &ReputationAnchor): u64 { anchor.created_at }

    public fun published_event_anchor_id(event: &AnchorPublished): ID { event.anchor_id }
    public fun published_event_author(event: &AnchorPublished): address { event.author }
    public fun published_event_merkle_root(event: &AnchorPublished): vector<u8> { event.merkle_root }
    public fun published_event_event_count(event: &AnchorPublished): u64 { event.event_count }
}