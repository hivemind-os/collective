#[allow(unused_const)]
module agentic_mesh::task {
    use std::string::String;
    use sui::balance::{Self, Balance};
    use sui::clock::Clock;
    use sui::coin::{Self, Coin};
    use sui::event;
    use sui::sui::SUI;

    const STATUS_OPEN: u8 = 0;
    const STATUS_ACCEPTED: u8 = 1;
    const STATUS_COMPLETED: u8 = 2;
    const STATUS_RELEASED: u8 = 3;
    const STATUS_DISPUTED: u8 = 4;
    const STATUS_CANCELLED: u8 = 5;

    const EInvalidStatus: u64 = 100;
    const ENotRequester: u64 = 101;
    const ENotProvider: u64 = 102;
    const EDisputeWindowOpen: u64 = 104;
    const EDisputeWindowClosed: u64 = 105;
    const ENoFunds: u64 = 106;
    const ENotCompleted: u64 = 107;
    const ETaskExpired: u64 = 108;
    const ETaskNotExpired: u64 = 109;
    const EZeroPayment: u64 = 110;

    const MS_PER_HOUR: u64 = 3_600_000;

    public struct Task has key {
        id: UID,
        requester: address,
        provider: address,
        capability: String,
        input_blob_id: vector<u8>,
        result_blob_id: vector<u8>,
        agreement_hash: vector<u8>,
        price: u64,
        escrow: Balance<SUI>,
        status: u8,
        dispute_window_ms: u64,
        expires_at: u64,
        created_at: u64,
        accepted_at: u64,
        completed_at: u64,
    }

    public struct TaskPosted has copy, drop {
        task_id: ID,
        requester: address,
        provider: address,
        capability: String,
        input_blob_id: vector<u8>,
        agreement_hash: vector<u8>,
        price: u64,
        status: u8,
        dispute_window_ms: u64,
        expires_at: u64,
        created_at: u64,
    }

    public struct TaskAccepted has copy, drop {
        task_id: ID,
        requester: address,
        provider: address,
        capability: String,
        price: u64,
        status: u8,
        accepted_at: u64,
    }

    public struct TaskCompleted has copy, drop {
        task_id: ID,
        requester: address,
        provider: address,
        capability: String,
        result_blob_id: vector<u8>,
        price: u64,
        status: u8,
        completed_at: u64,
    }

    public struct TaskPaymentReleased has copy, drop {
        task_id: ID,
        requester: address,
        provider: address,
        capability: String,
        price: u64,
        status: u8,
        released_by: address,
    }

    public struct TaskDisputed has copy, drop {
        task_id: ID,
        requester: address,
        provider: address,
        capability: String,
        price: u64,
        status: u8,
        disputed_at: u64,
    }

    public struct TaskCancelled has copy, drop {
        task_id: ID,
        requester: address,
        provider: address,
        capability: String,
        price: u64,
        status: u8,
        refund_amount: u64,
    }

    public struct TaskExpiredRefunded has copy, drop {
        task_id: ID,
        requester: address,
        provider: address,
        capability: String,
        price: u64,
        status: u8,
        refunded_by: address,
        refund_amount: u64,
    }

    fun release_escrow(task: &mut Task, recipient: address, ctx: &mut TxContext): u64 {
        let amount = balance::value(&task.escrow);
        assert!(amount > 0, ENoFunds);

        let payment = coin::from_balance(balance::split(&mut task.escrow, amount), ctx);
        transfer::public_transfer(payment, recipient);
        amount
    }

    public fun post_task(
        capability: String,
        input_blob_id: vector<u8>,
        agreement_hash: vector<u8>,
        payment: Coin<SUI>,
        dispute_window_ms: u64,
        expiry_hours: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let price = coin::value(&payment);
        assert!(price > 0, EZeroPayment);

        let now = clock.timestamp_ms();
        let task = Task {
            id: object::new(ctx),
            requester: ctx.sender(),
            provider: @0x0,
            capability,
            input_blob_id,
            result_blob_id: vector[],
            agreement_hash,
            price,
            escrow: coin::into_balance(payment),
            status: STATUS_OPEN,
            dispute_window_ms,
            expires_at: now + (expiry_hours * MS_PER_HOUR),
            created_at: now,
            accepted_at: 0,
            completed_at: 0,
        };

        event::emit(TaskPosted {
            task_id: object::id(&task),
            requester: task.requester,
            provider: task.provider,
            capability: task.capability,
            input_blob_id: task.input_blob_id,
            agreement_hash: task.agreement_hash,
            price: task.price,
            status: task.status,
            dispute_window_ms: task.dispute_window_ms,
            expires_at: task.expires_at,
            created_at: task.created_at,
        });

        transfer::share_object(task);
    }

    public fun accept_task(task: &mut Task, clock: &Clock, ctx: &mut TxContext) {
        assert!(task.status == STATUS_OPEN, EInvalidStatus);
        let now = clock.timestamp_ms();
        assert!(now < task.expires_at, ETaskExpired);
        assert!(ctx.sender() != task.requester, ENotProvider);

        task.provider = ctx.sender();
        task.status = STATUS_ACCEPTED;
        task.accepted_at = now;

        event::emit(TaskAccepted {
            task_id: object::id(task),
            requester: task.requester,
            provider: task.provider,
            capability: task.capability,
            price: task.price,
            status: task.status,
            accepted_at: task.accepted_at,
        });
    }

    public fun complete_task(
        task: &mut Task,
        result_blob_id: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(task.status == STATUS_ACCEPTED, EInvalidStatus);
        assert!(ctx.sender() == task.provider, ENotProvider);

        task.result_blob_id = result_blob_id;
        task.status = STATUS_COMPLETED;
        task.completed_at = clock.timestamp_ms();

        event::emit(TaskCompleted {
            task_id: object::id(task),
            requester: task.requester,
            provider: task.provider,
            capability: task.capability,
            result_blob_id: task.result_blob_id,
            price: task.price,
            status: task.status,
            completed_at: task.completed_at,
        });
    }

    public fun release_payment(task: &mut Task, ctx: &mut TxContext) {
        assert!(task.status == STATUS_COMPLETED, ENotCompleted);
        assert!(ctx.sender() == task.requester, ENotRequester);

        let provider = task.provider;
        let _released_amount = release_escrow(task, provider, ctx);
        task.status = STATUS_RELEASED;

        event::emit(TaskPaymentReleased {
            task_id: object::id(task),
            requester: task.requester,
            provider: task.provider,
            capability: task.capability,
            price: task.price,
            status: task.status,
            released_by: ctx.sender(),
        });
    }

    public fun claim_payment(task: &mut Task, clock: &Clock, ctx: &mut TxContext) {
        assert!(task.status == STATUS_COMPLETED, ENotCompleted);
        assert!(ctx.sender() == task.provider, ENotProvider);
        assert!(clock.timestamp_ms() >= task.completed_at + task.dispute_window_ms, EDisputeWindowOpen);

        let provider = task.provider;
        let _released_amount = release_escrow(task, provider, ctx);
        task.status = STATUS_RELEASED;

        event::emit(TaskPaymentReleased {
            task_id: object::id(task),
            requester: task.requester,
            provider: task.provider,
            capability: task.capability,
            price: task.price,
            status: task.status,
            released_by: ctx.sender(),
        });
    }

    public fun cancel_task(task: &mut Task, ctx: &mut TxContext) {
        assert!(task.status == STATUS_OPEN, EInvalidStatus);
        assert!(ctx.sender() == task.requester, ENotRequester);

        let requester = task.requester;
        let refund_amount = release_escrow(task, requester, ctx);
        task.status = STATUS_CANCELLED;

        event::emit(TaskCancelled {
            task_id: object::id(task),
            requester: task.requester,
            provider: task.provider,
            capability: task.capability,
            price: task.price,
            status: task.status,
            refund_amount,
        });
    }

    public fun refund_expired_task(task: &mut Task, clock: &Clock, ctx: &mut TxContext) {
        assert!(task.status == STATUS_OPEN, EInvalidStatus);
        assert!(clock.timestamp_ms() >= task.expires_at, ETaskNotExpired);

        let requester = task.requester;
        let refund_amount = release_escrow(task, requester, ctx);
        task.status = STATUS_CANCELLED;

        event::emit(TaskExpiredRefunded {
            task_id: object::id(task),
            requester: task.requester,
            provider: task.provider,
            capability: task.capability,
            price: task.price,
            status: task.status,
            refunded_by: ctx.sender(),
            refund_amount,
        });
    }

    public fun dispute_task(task: &mut Task, clock: &Clock, ctx: &mut TxContext) {
        assert!(task.status == STATUS_COMPLETED, ENotCompleted);
        assert!(ctx.sender() == task.requester, ENotRequester);
        assert!(clock.timestamp_ms() < task.completed_at + task.dispute_window_ms, EDisputeWindowClosed);

        task.status = STATUS_DISPUTED;

        event::emit(TaskDisputed {
            task_id: object::id(task),
            requester: task.requester,
            provider: task.provider,
            capability: task.capability,
            price: task.price,
            status: task.status,
            disputed_at: clock.timestamp_ms(),
        });
    }

    public fun task_id(task: &Task): ID { object::id(task) }
    public fun task_requester(task: &Task): address { task.requester }
    public fun task_provider(task: &Task): address { task.provider }
    public fun task_capability(task: &Task): String { task.capability }
    public fun task_input_blob_id(task: &Task): vector<u8> { task.input_blob_id }
    public fun task_result_blob_id(task: &Task): vector<u8> { task.result_blob_id }
    public fun task_agreement_hash(task: &Task): vector<u8> { task.agreement_hash }
    public fun task_price(task: &Task): u64 { task.price }
    public fun task_status(task: &Task): u8 { task.status }
    public fun task_dispute_window_ms(task: &Task): u64 { task.dispute_window_ms }
    public fun task_expires_at(task: &Task): u64 { task.expires_at }
    public fun task_created_at(task: &Task): u64 { task.created_at }
    public fun task_accepted_at(task: &Task): u64 { task.accepted_at }
    public fun task_completed_at(task: &Task): u64 { task.completed_at }
    public fun task_escrow_value(task: &Task): u64 { balance::value(&task.escrow) }

    public fun status_open(): u8 { STATUS_OPEN }
    public fun status_accepted(): u8 { STATUS_ACCEPTED }
    public fun status_completed(): u8 { STATUS_COMPLETED }
    public fun status_released(): u8 { STATUS_RELEASED }
    public fun status_disputed(): u8 { STATUS_DISPUTED }
    public fun status_cancelled(): u8 { STATUS_CANCELLED }

    public fun posted_event_task_id(event: &TaskPosted): ID { event.task_id }
    public fun posted_event_requester(event: &TaskPosted): address { event.requester }
    public fun posted_event_provider(event: &TaskPosted): address { event.provider }
    public fun posted_event_capability(event: &TaskPosted): String { event.capability }
    public fun posted_event_input_blob_id(event: &TaskPosted): vector<u8> { event.input_blob_id }
    public fun posted_event_agreement_hash(event: &TaskPosted): vector<u8> { event.agreement_hash }
    public fun posted_event_price(event: &TaskPosted): u64 { event.price }
    public fun posted_event_status(event: &TaskPosted): u8 { event.status }
    public fun posted_event_dispute_window_ms(event: &TaskPosted): u64 { event.dispute_window_ms }
    public fun posted_event_expires_at(event: &TaskPosted): u64 { event.expires_at }
    public fun posted_event_created_at(event: &TaskPosted): u64 { event.created_at }

    public fun accepted_event_task_id(event: &TaskAccepted): ID { event.task_id }
    public fun accepted_event_provider(event: &TaskAccepted): address { event.provider }
    public fun accepted_event_capability(event: &TaskAccepted): String { event.capability }
    public fun accepted_event_price(event: &TaskAccepted): u64 { event.price }
    public fun accepted_event_status(event: &TaskAccepted): u8 { event.status }
    public fun accepted_event_accepted_at(event: &TaskAccepted): u64 { event.accepted_at }

    public fun completed_event_task_id(event: &TaskCompleted): ID { event.task_id }
    public fun completed_event_provider(event: &TaskCompleted): address { event.provider }
    public fun completed_event_result_blob_id(event: &TaskCompleted): vector<u8> { event.result_blob_id }
    public fun completed_event_price(event: &TaskCompleted): u64 { event.price }
    public fun completed_event_status(event: &TaskCompleted): u8 { event.status }
    public fun completed_event_completed_at(event: &TaskCompleted): u64 { event.completed_at }

    public fun payment_released_event_task_id(event: &TaskPaymentReleased): ID { event.task_id }
    public fun payment_released_event_provider(event: &TaskPaymentReleased): address { event.provider }
    public fun payment_released_event_price(event: &TaskPaymentReleased): u64 { event.price }
    public fun payment_released_event_status(event: &TaskPaymentReleased): u8 { event.status }
    public fun payment_released_event_released_by(event: &TaskPaymentReleased): address { event.released_by }

    public fun disputed_event_status(event: &TaskDisputed): u8 { event.status }
    public fun cancelled_event_refund_amount(event: &TaskCancelled): u64 { event.refund_amount }
    public fun expired_refund_event_refunded_by(event: &TaskExpiredRefunded): address { event.refunded_by }
    public fun expired_refund_event_refund_amount(event: &TaskExpiredRefunded): u64 { event.refund_amount }
}
