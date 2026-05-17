module agentic_mesh::dispute {
    use agentic_mesh::task::{Self as task, Task};
    use sui::balance::{Self as balance, Balance};
    use sui::clock::Clock;
    use sui::coin;
    use sui::event;

    const RESOLUTION_PERIOD_MS: u64 = 604_800_000;

    const STATUS_OPEN: u8 = 0;
    const STATUS_RESPONDED: u8 = 1;
    const STATUS_MUTUAL_RESOLVED: u8 = 2;
    const STATUS_ARBITRATED: u8 = 3;
    const STATUS_EXPIRED: u8 = 4;

    const E_NOT_REQUESTER: u64 = 1;
    const E_NOT_PROVIDER: u64 = 2;
    const E_TASK_NOT_COMPLETED: u64 = 3;
    const E_DISPUTE_WINDOW_EXPIRED: u64 = 4;
    const E_ALREADY_DISPUTED: u64 = 5;
    const E_DISPUTE_NOT_OPEN: u64 = 6;
    const E_INVALID_SPLIT: u64 = 7;
    const E_RESOLUTION_PERIOD_EXPIRED: u64 = 8;
    const E_NOT_ARBITRATOR: u64 = 9;
    const E_TASK_MISMATCH: u64 = 10;

    public struct Dispute has key, store {
        id: UID,
        task_id: ID,
        requester: address,
        provider: address,
        escrow_amount: u64,
        status: u8,
        requester_evidence_blob: vector<u8>,
        provider_evidence_blob: vector<u8>,
        requester_proposed_split: u64,
        provider_proposed_split: u64,
        arbitrator: address,
        ruling_split: u64,
        opened_at: u64,
        responded_at: u64,
        resolved_at: u64,
        resolution_deadline: u64,
    }

    public struct DisputeOpened has copy, drop {
        dispute_id: ID,
        task_id: ID,
        requester: address,
        provider: address,
        escrow_amount: u64,
    }

    public struct DisputeResponded has copy, drop {
        dispute_id: ID,
        provider: address,
        provider_evidence_blob: vector<u8>,
    }

    public struct DisputeMutuallyResolved has copy, drop {
        dispute_id: ID,
        requester_amount: u64,
        provider_amount: u64,
    }

    public struct DisputeArbitrated has copy, drop {
        dispute_id: ID,
        arbitrator: address,
        requester_amount: u64,
        provider_amount: u64,
    }

    public struct DisputeExpired has copy, drop {
        dispute_id: ID,
    }

    public fun open_dispute<T>(
        task: &mut Task<T>,
        evidence_blob: vector<u8>,
        proposed_split: u64,
        arbitrator: address,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let sender = ctx.sender();
        let task_status = task::task_status(task);
        if (task_status == task::status_disputed()) {
            abort E_ALREADY_DISPUTED
        };
        assert!(task_status == task::status_completed(), E_TASK_NOT_COMPLETED);
        assert!(sender == task::task_requester(task), E_NOT_REQUESTER);

        let escrow_amount = task::task_escrow_value(task);
        assert!(proposed_split <= escrow_amount, E_INVALID_SPLIT);

        let completed_at = task::get_completed_at(task);
        let dispute_window_ms = task::get_dispute_window_ms(task);
        let opened_at = clock.timestamp_ms();
        assert!(opened_at >= completed_at, E_DISPUTE_WINDOW_EXPIRED);
        assert!(opened_at - completed_at < dispute_window_ms, E_DISPUTE_WINDOW_EXPIRED);

        let dispute = Dispute {
            id: object::new(ctx),
            task_id: task::task_id(task),
            requester: task::task_requester(task),
            provider: task::task_provider(task),
            escrow_amount,
            status: STATUS_OPEN,
            requester_evidence_blob: evidence_blob,
            provider_evidence_blob: vector[],
            requester_proposed_split: proposed_split,
            provider_proposed_split: 0,
            arbitrator,
            ruling_split: 0,
            opened_at,
            responded_at: 0,
            resolved_at: 0,
            resolution_deadline: opened_at + RESOLUTION_PERIOD_MS,
        };

        task::set_disputed(task);
        task::emit_disputed_event(task, opened_at);

        event::emit(DisputeOpened {
            dispute_id: object::id(&dispute),
            task_id: dispute.task_id,
            requester: dispute.requester,
            provider: dispute.provider,
            escrow_amount: dispute.escrow_amount,
        });

        transfer::share_object(dispute);
    }

    public fun respond_to_dispute(
        dispute: &mut Dispute,
        evidence_blob: vector<u8>,
        proposed_split: u64,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert!(ctx.sender() == dispute.provider, E_NOT_PROVIDER);
        assert!(dispute.status == STATUS_OPEN, E_DISPUTE_NOT_OPEN);
        assert!(clock.timestamp_ms() < dispute.resolution_deadline, E_RESOLUTION_PERIOD_EXPIRED);
        assert!(proposed_split <= dispute.escrow_amount, E_INVALID_SPLIT);

        dispute.provider_evidence_blob = evidence_blob;
        dispute.provider_proposed_split = proposed_split;
        dispute.responded_at = clock.timestamp_ms();
        dispute.status = STATUS_RESPONDED;

        event::emit(DisputeResponded {
            dispute_id: object::id(dispute),
            provider: dispute.provider,
            provider_evidence_blob: dispute.provider_evidence_blob,
        });
    }

    public fun accept_resolution<T>(
        dispute: &mut Dispute,
        task: &mut Task<T>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_task_match<T>(dispute, task);
        assert!(
            dispute.status == STATUS_OPEN || dispute.status == STATUS_RESPONDED,
            E_DISPUTE_NOT_OPEN,
        );
        assert!(clock.timestamp_ms() < dispute.resolution_deadline, E_RESOLUTION_PERIOD_EXPIRED);

        let sender = ctx.sender();
        if (sender == dispute.requester) {
            assert!(dispute.status == STATUS_RESPONDED, E_DISPUTE_NOT_OPEN);
            dispute.requester_proposed_split = dispute.provider_proposed_split;
        } else {
            assert!(sender == dispute.provider, E_NOT_PROVIDER);
            dispute.provider_proposed_split = dispute.requester_proposed_split;
        };

        let requester_amount = dispute.requester_proposed_split;
        let provider_amount = settle_split<T>(dispute, task, requester_amount, STATUS_MUTUAL_RESOLVED, clock, ctx);
        event::emit(DisputeMutuallyResolved {
            dispute_id: object::id(dispute),
            requester_amount,
            provider_amount,
        });
    }

    public fun arbitrate<T>(
        dispute: &mut Dispute,
        task: &mut Task<T>,
        ruling_split: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_task_match<T>(dispute, task);
        assert!(
            dispute.status == STATUS_OPEN || dispute.status == STATUS_RESPONDED,
            E_DISPUTE_NOT_OPEN,
        );
        assert!(ctx.sender() == dispute.arbitrator, E_NOT_ARBITRATOR);
        assert!(clock.timestamp_ms() < dispute.resolution_deadline, E_RESOLUTION_PERIOD_EXPIRED);
        assert!(ruling_split <= dispute.escrow_amount, E_INVALID_SPLIT);

        dispute.ruling_split = ruling_split;
        let provider_amount = settle_split<T>(dispute, task, ruling_split, STATUS_ARBITRATED, clock, ctx);
        event::emit(DisputeArbitrated {
            dispute_id: object::id(dispute),
            arbitrator: dispute.arbitrator,
            requester_amount: ruling_split,
            provider_amount,
        });
    }

    public fun expire_dispute<T>(
        dispute: &mut Dispute,
        task: &mut Task<T>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_task_match<T>(dispute, task);
        assert!(
            dispute.status == STATUS_OPEN || dispute.status == STATUS_RESPONDED,
            E_DISPUTE_NOT_OPEN,
        );
        assert!(clock.timestamp_ms() >= dispute.resolution_deadline, E_RESOLUTION_PERIOD_EXPIRED);

        let _provider_amount = settle_split<T>(dispute, task, 0, STATUS_EXPIRED, clock, ctx);
        event::emit(DisputeExpired {
            dispute_id: object::id(dispute),
        });
    }

    fun assert_task_match<T>(dispute: &Dispute, task: &Task<T>) {
        assert!(dispute.task_id == task::task_id(task), E_TASK_MISMATCH);
        assert!(task::task_status(task) == task::status_disputed(), E_DISPUTE_NOT_OPEN);
    }

    fun settle_split<T>(
        dispute: &mut Dispute,
        task: &mut Task<T>,
        requester_amount: u64,
        resolved_status: u8,
        clock: &Clock,
        ctx: &mut TxContext,
    ): u64 {
        assert!(requester_amount <= dispute.escrow_amount, E_INVALID_SPLIT);

        let (requester_balance, provider_balance) = task::split_escrow<T>(task, requester_amount);
        let provider_amount = dispute.escrow_amount - requester_amount;

        transfer_balance<T>(requester_balance, dispute.requester, ctx);
        transfer_balance<T>(provider_balance, dispute.provider, ctx);

        dispute.status = resolved_status;
        dispute.resolved_at = clock.timestamp_ms();
        provider_amount
    }

    fun transfer_balance<T>(balance_ref: Balance<T>, recipient: address, ctx: &mut TxContext) {
        if (balance::value(&balance_ref) == 0) {
            balance::destroy_zero(balance_ref);
            return
        };

        let payment = coin::from_balance(balance_ref, ctx);
        transfer::public_transfer(payment, recipient);
    }

    public fun dispute_id(dispute: &Dispute): ID { object::id(dispute) }
    public fun dispute_task_id(dispute: &Dispute): ID { dispute.task_id }
    public fun dispute_requester(dispute: &Dispute): address { dispute.requester }
    public fun dispute_provider(dispute: &Dispute): address { dispute.provider }
    public fun dispute_escrow_amount(dispute: &Dispute): u64 { dispute.escrow_amount }
    public fun dispute_status(dispute: &Dispute): u8 { dispute.status }
    public fun dispute_requester_evidence_blob(dispute: &Dispute): vector<u8> { dispute.requester_evidence_blob }
    public fun dispute_provider_evidence_blob(dispute: &Dispute): vector<u8> { dispute.provider_evidence_blob }
    public fun dispute_requester_proposed_split(dispute: &Dispute): u64 { dispute.requester_proposed_split }
    public fun dispute_provider_proposed_split(dispute: &Dispute): u64 { dispute.provider_proposed_split }
    public fun dispute_arbitrator(dispute: &Dispute): address { dispute.arbitrator }
    public fun dispute_ruling_split(dispute: &Dispute): u64 { dispute.ruling_split }
    public fun dispute_opened_at(dispute: &Dispute): u64 { dispute.opened_at }
    public fun dispute_responded_at(dispute: &Dispute): u64 { dispute.responded_at }
    public fun dispute_resolved_at(dispute: &Dispute): u64 { dispute.resolved_at }
    public fun dispute_resolution_deadline(dispute: &Dispute): u64 { dispute.resolution_deadline }

    public fun status_open(): u8 { STATUS_OPEN }
    public fun status_responded(): u8 { STATUS_RESPONDED }
    public fun status_mutual_resolved(): u8 { STATUS_MUTUAL_RESOLVED }
    public fun status_arbitrated(): u8 { STATUS_ARBITRATED }
    public fun status_expired(): u8 { STATUS_EXPIRED }

    public fun opened_event_dispute_id(event: &DisputeOpened): ID { event.dispute_id }
    public fun opened_event_task_id(event: &DisputeOpened): ID { event.task_id }
    public fun opened_event_requester(event: &DisputeOpened): address { event.requester }
    public fun opened_event_provider(event: &DisputeOpened): address { event.provider }
    public fun opened_event_escrow_amount(event: &DisputeOpened): u64 { event.escrow_amount }

    public fun responded_event_dispute_id(event: &DisputeResponded): ID { event.dispute_id }
    public fun responded_event_provider(event: &DisputeResponded): address { event.provider }
    public fun responded_event_provider_evidence_blob(event: &DisputeResponded): vector<u8> { event.provider_evidence_blob }

    public fun mutual_resolved_event_dispute_id(event: &DisputeMutuallyResolved): ID { event.dispute_id }
    public fun mutual_resolved_event_requester_amount(event: &DisputeMutuallyResolved): u64 { event.requester_amount }
    public fun mutual_resolved_event_provider_amount(event: &DisputeMutuallyResolved): u64 { event.provider_amount }

    public fun arbitrated_event_dispute_id(event: &DisputeArbitrated): ID { event.dispute_id }
    public fun arbitrated_event_arbitrator(event: &DisputeArbitrated): address { event.arbitrator }
    public fun arbitrated_event_requester_amount(event: &DisputeArbitrated): u64 { event.requester_amount }
    public fun arbitrated_event_provider_amount(event: &DisputeArbitrated): u64 { event.provider_amount }

    public fun expired_event_dispute_id(event: &DisputeExpired): ID { event.dispute_id }
}
