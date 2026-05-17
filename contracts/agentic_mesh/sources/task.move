#[allow(unused_const)]
module agentic_mesh::task {
    use agentic_mesh::registry::{Self as registry, AgentCard};
    use agentic_mesh::reputation;
    use std::string::String;
    use std::vector;
    use sui::balance::{Self, Balance};
    use sui::clock::Clock;
    use sui::coin::{Self, Coin};
    use sui::event;

    const STATUS_OPEN: u8 = 0;
    const STATUS_ACCEPTED: u8 = 1;
    const STATUS_COMPLETED: u8 = 2;
    const STATUS_RELEASED: u8 = 3;
    const STATUS_DISPUTED: u8 = 4;
    const STATUS_CANCELLED: u8 = 5;

    const SCHEME_EXACT: u8 = 0;
    const SCHEME_UPTO: u8 = 1;
    const SCHEME_STREAM: u8 = 2;

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
    const EInvalidProviderCard: u64 = 111;
    const EInvalidSplit: u64 = 112;
    const EInvalidBidPrice: u64 = 113;
    const EInvalidExpiryHours: u64 = 114;
    const EInvalidPaymentScheme: u64 = 115;

    const MS_PER_HOUR: u64 = 3_600_000;
    const MAX_U64: u64 = 18_446_744_073_709_551_615;

    public struct Task<phantom T> has key {
        id: UID,
        requester: address,
        provider: address,
        capability: String,
        category: String,
        input_blob_id: vector<u8>,
        result_blob_id: vector<u8>,
        agreement_hash: vector<u8>,
        price: u64,
        payment_scheme: u8,
        max_price: u64,
        metered_units: u64,
        unit_price: u64,
        verification_hash: vector<u8>,
        escrow: Balance<T>,
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
        category: String,
        input_blob_id: vector<u8>,
        agreement_hash: vector<u8>,
        price: u64,
        payment_scheme: u8,
        max_price: u64,
        unit_price: u64,
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
        payment_scheme: u8,
        metered_units: u64,
        verification_hash: vector<u8>,
        status: u8,
        completed_at: u64,
    }

    public struct TaskPaymentReleased has copy, drop {
        task_id: ID,
        requester: address,
        provider: address,
        capability: String,
        price: u64,
        refund_amount: u64,
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

    fun release_escrow<T>(task: &mut Task<T>, recipient: address, ctx: &mut TxContext): u64 {
        let amount = balance::value(&task.escrow);
        assert!(amount > 0, ENoFunds);

        let payment = coin::from_balance(balance::split(&mut task.escrow, amount), ctx);
        transfer::public_transfer(payment, recipient);
        amount
    }

    fun assert_provider_card<T>(task: &Task<T>, provider_card: &AgentCard) {
        assert!(registry::card_owner(provider_card) == task.provider, EInvalidProviderCard);
    }

    fun assert_metered_scheme<T>(task: &Task<T>) {
        assert!(task.payment_scheme == SCHEME_UPTO || task.payment_scheme == SCHEME_STREAM, EInvalidPaymentScheme);
    }

    fun emit_task_posted<T>(task: &Task<T>) {
        event::emit(TaskPosted {
            task_id: object::id(task),
            requester: task.requester,
            provider: task.provider,
            capability: task.capability,
            category: task.category,
            input_blob_id: task.input_blob_id,
            agreement_hash: task.agreement_hash,
            price: task.price,
            payment_scheme: task.payment_scheme,
            max_price: task.max_price,
            unit_price: task.unit_price,
            status: task.status,
            dispute_window_ms: task.dispute_window_ms,
            expires_at: task.expires_at,
            created_at: task.created_at,
        });
    }

    fun emit_task_completed<T>(task: &Task<T>) {
        event::emit(TaskCompleted {
            task_id: object::id(task),
            requester: task.requester,
            provider: task.provider,
            capability: task.capability,
            result_blob_id: task.result_blob_id,
            price: task.price,
            payment_scheme: task.payment_scheme,
            metered_units: task.metered_units,
            verification_hash: task.verification_hash,
            status: task.status,
            completed_at: task.completed_at,
        });
    }

    fun emit_payment_released_event<T>(task: &Task<T>, released_by: address, refund_amount: u64) {
        event::emit(TaskPaymentReleased {
            task_id: object::id(task),
            requester: task.requester,
            provider: task.provider,
            capability: task.capability,
            price: task.price,
            refund_amount,
            status: task.status,
            released_by,
        });
    }

    public(package) fun set_disputed<T>(task: &mut Task<T>) {
        task.status = STATUS_DISPUTED;
    }

    public(package) fun emit_disputed_event<T>(task: &Task<T>, disputed_at: u64) {
        event::emit(TaskDisputed {
            task_id: object::id(task),
            requester: task.requester,
            provider: task.provider,
            capability: task.capability,
            price: task.price,
            status: task.status,
            disputed_at,
        });
    }

    public(package) fun split_escrow<T>(task: &mut Task<T>, requester_amount: u64): (Balance<T>, Balance<T>) {
        let escrow_amount = balance::value(&task.escrow);
        assert!(escrow_amount > 0, ENoFunds);
        assert!(requester_amount <= escrow_amount, EInvalidSplit);

        let requester_balance = balance::split(&mut task.escrow, requester_amount);
        let provider_balance = balance::split(&mut task.escrow, escrow_amount - requester_amount);
        task.status = STATUS_RELEASED;
        (requester_balance, provider_balance)
    }

    public(package) fun get_dispute_window_ms<T>(task: &Task<T>): u64 {
        task.dispute_window_ms
    }

    public(package) fun get_completed_at<T>(task: &Task<T>): u64 {
        task.completed_at
    }

    fun assert_dispute_window_open<T>(task: &Task<T>, now: u64) {
        assert!(now >= task.completed_at, EDisputeWindowOpen);
        assert!(now - task.completed_at >= task.dispute_window_ms, EDisputeWindowOpen);
    }

    fun assert_dispute_window_not_closed<T>(task: &Task<T>, now: u64) {
        assert!(now >= task.completed_at, EDisputeWindowClosed);
        assert!(now - task.completed_at < task.dispute_window_ms, EDisputeWindowClosed);
    }

    fun compute_expiry_delta(expiry_hours: u64): u64 {
        assert!(expiry_hours <= MAX_U64 / MS_PER_HOUR, EInvalidExpiryHours);
        expiry_hours * MS_PER_HOUR
    }

    fun compute_metered_cost(metered_units: u64, unit_price: u64, max_price: u64): u64 {
        if (metered_units == 0 || unit_price == 0) {
            return 0
        };
        if (metered_units > MAX_U64 / unit_price) {
            return max_price
        };

        let actual_cost = metered_units * unit_price;
        if (actual_cost > max_price) {
            max_price
        } else {
            actual_cost
        }
    }

    fun release_metered_amounts<T>(task: &mut Task<T>, ctx: &mut TxContext): (u64, u64) {
        let escrow_amount = balance::value(&task.escrow);
        assert!(escrow_amount > 0, ENoFunds);

        let computed_amount = compute_metered_cost(task.metered_units, task.unit_price, task.max_price);
        let provider_amount = if (computed_amount > escrow_amount) {
            escrow_amount
        } else {
            computed_amount
        };
        let refund_amount = escrow_amount - provider_amount;

        if (provider_amount > 0) {
            let payment = coin::from_balance(balance::split(&mut task.escrow, provider_amount), ctx);
            transfer::public_transfer(payment, task.provider);
        };
        if (refund_amount > 0) {
            let refund = coin::from_balance(balance::split(&mut task.escrow, refund_amount), ctx);
            transfer::public_transfer(refund, task.requester);
        };

        (provider_amount, refund_amount)
    }

    fun vector_equals(left: &vector<u8>, right: &vector<u8>): bool {
        if (vector::length(left) != vector::length(right)) {
            return false
        };

        let mut index = 0;
        let length = vector::length(left);
        while (index < length) {
            if (*vector::borrow(left, index) != *vector::borrow(right, index)) {
                return false
            };
            index = index + 1;
        };

        true
    }

    public(package) fun accept_bid_for_task<T>(
        task: &mut Task<T>,
        provider: address,
        bid_price: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ): u64 {
        assert!(task.status == STATUS_OPEN, EInvalidStatus);
        let now = clock.timestamp_ms();
        assert!(now < task.expires_at, ETaskExpired);
        assert!(ctx.sender() == task.requester, ENotRequester);
        assert!(provider != task.requester, ENotProvider);
        assert!(bid_price > 0 && bid_price <= task.price, EInvalidBidPrice);

        let refund_amount = task.price - bid_price;
        if (refund_amount > 0) {
            let refund = coin::from_balance(balance::split(&mut task.escrow, refund_amount), ctx);
            transfer::public_transfer(refund, task.requester);
        };

        task.provider = provider;
        task.price = bid_price;
        task.max_price = bid_price;
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

        refund_amount
    }

    public fun post_task<T>(
        capability: String,
        category: String,
        input_blob_id: vector<u8>,
        agreement_hash: vector<u8>,
        payment: Coin<T>,
        dispute_window_ms: u64,
        expiry_hours: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let price = coin::value(&payment);
        assert!(price > 0, EZeroPayment);

        let now = clock.timestamp_ms();
        let expiry_delta = compute_expiry_delta(expiry_hours);
        assert!(now <= MAX_U64 - expiry_delta, EInvalidExpiryHours);
        let task = Task<T> {
            id: object::new(ctx),
            requester: ctx.sender(),
            provider: @0x0,
            capability,
            category,
            input_blob_id,
            result_blob_id: vector[],
            agreement_hash,
            price,
            payment_scheme: SCHEME_EXACT,
            max_price: price,
            metered_units: 0,
            unit_price: 0,
            verification_hash: vector[],
            escrow: coin::into_balance(payment),
            status: STATUS_OPEN,
            dispute_window_ms,
            expires_at: now + expiry_delta,
            created_at: now,
            accepted_at: 0,
            completed_at: 0,
        };

        emit_task_posted(&task);
        transfer::share_object(task);
    }

    public fun post_metered_task<T>(
        capability: String,
        input_blob_id: vector<u8>,
        agreement_hash: vector<u8>,
        payment: Coin<T>,
        unit_price: u64,
        dispute_window_ms: u64,
        expiry_hours: u64,
        category: String,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let max_price = coin::value(&payment);
        assert!(max_price > 0, EZeroPayment);
        assert!(unit_price > 0, EZeroPayment);

        let now = clock.timestamp_ms();
        let expiry_delta = compute_expiry_delta(expiry_hours);
        assert!(now <= MAX_U64 - expiry_delta, EInvalidExpiryHours);
        let task = Task<T> {
            id: object::new(ctx),
            requester: ctx.sender(),
            provider: @0x0,
            capability,
            category,
            input_blob_id,
            result_blob_id: vector[],
            agreement_hash,
            price: max_price,
            payment_scheme: SCHEME_UPTO,
            max_price,
            metered_units: 0,
            unit_price,
            verification_hash: vector[],
            escrow: coin::into_balance(payment),
            status: STATUS_OPEN,
            dispute_window_ms,
            expires_at: now + expiry_delta,
            created_at: now,
            accepted_at: 0,
            completed_at: 0,
        };

        emit_task_posted(&task);
        transfer::share_object(task);
    }

    public fun post_open_task<T>(
        capability: String,
        category: String,
        input_blob_id: vector<u8>,
        agreement_hash: vector<u8>,
        payment: Coin<T>,
        dispute_window_ms: u64,
        expiry_hours: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        post_task(
            capability,
            category,
            input_blob_id,
            agreement_hash,
            payment,
            dispute_window_ms,
            expiry_hours,
            clock,
            ctx,
        );
    }

    public fun accept_task<T>(task: &mut Task<T>, clock: &Clock, ctx: &mut TxContext) {
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

    public fun complete_task<T>(
        task: &mut Task<T>,
        result_blob_id: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(task.status == STATUS_ACCEPTED, EInvalidStatus);
        assert!(ctx.sender() == task.provider, ENotProvider);

        task.result_blob_id = result_blob_id;
        task.metered_units = 0;
        task.verification_hash = vector[];
        task.status = STATUS_COMPLETED;
        task.completed_at = clock.timestamp_ms();

        emit_task_completed(task);
    }

    public fun complete_task_with_card<T>(
        task: &mut Task<T>,
        provider_card: &mut AgentCard,
        result_blob_id: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_provider_card(task, provider_card);
        complete_task(task, result_blob_id, clock, ctx);
        reputation::record_task_completion(provider_card);
    }

    public fun complete_metered_task<T>(
        task: &mut Task<T>,
        metered_units: u64,
        result_blob_id: vector<u8>,
        verification_hash: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(task.status == STATUS_ACCEPTED, EInvalidStatus);
        assert!(ctx.sender() == task.provider, ENotProvider);
        assert_metered_scheme(task);

        task.result_blob_id = result_blob_id;
        task.metered_units = metered_units;
        task.verification_hash = verification_hash;
        task.price = compute_metered_cost(metered_units, task.unit_price, task.max_price);
        task.status = STATUS_COMPLETED;
        task.completed_at = clock.timestamp_ms();

        emit_task_completed(task);
    }

    public fun complete_metered_task_with_card<T>(
        task: &mut Task<T>,
        provider_card: &mut AgentCard,
        metered_units: u64,
        result_blob_id: vector<u8>,
        verification_hash: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_provider_card(task, provider_card);
        complete_metered_task(task, metered_units, result_blob_id, verification_hash, clock, ctx);
        reputation::record_task_completion(provider_card);
    }

    public fun release_payment<T>(task: &mut Task<T>, ctx: &mut TxContext) {
        assert!(task.status == STATUS_COMPLETED, ENotCompleted);
        assert!(ctx.sender() == task.requester, ENotRequester);

        if (task.payment_scheme == SCHEME_EXACT) {
            let provider = task.provider;
            let _released_amount = release_escrow(task, provider, ctx);
            task.status = STATUS_RELEASED;
            emit_payment_released_event(task, ctx.sender(), 0);
        } else {
            release_metered_payment(task, ctx);
        };
    }

    public fun release_metered_payment<T>(task: &mut Task<T>, ctx: &mut TxContext) {
        assert!(task.status == STATUS_COMPLETED, ENotCompleted);
        assert!(ctx.sender() == task.requester, ENotRequester);
        assert_metered_scheme(task);

        let (_provider_amount, refund_amount) = release_metered_amounts(task, ctx);
        task.status = STATUS_RELEASED;
        emit_payment_released_event(task, ctx.sender(), refund_amount);
    }

    public fun claim_payment<T>(task: &mut Task<T>, clock: &Clock, ctx: &mut TxContext) {
        assert!(task.status == STATUS_COMPLETED, ENotCompleted);
        assert!(ctx.sender() == task.provider, ENotProvider);
        assert_dispute_window_open(task, clock.timestamp_ms());

        if (task.payment_scheme == SCHEME_EXACT) {
            let provider = task.provider;
            let _released_amount = release_escrow(task, provider, ctx);
            task.status = STATUS_RELEASED;
            emit_payment_released_event(task, ctx.sender(), 0);
        } else {
            assert_metered_scheme(task);
            let (_released_amount, refund_amount) = release_metered_amounts(task, ctx);
            task.status = STATUS_RELEASED;
            emit_payment_released_event(task, ctx.sender(), refund_amount);
        };
    }

    public fun claim_payment_with_card<T>(
        task: &mut Task<T>,
        provider_card: &mut AgentCard,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert_provider_card(task, provider_card);
        assert!(task.status == STATUS_COMPLETED, ENotCompleted);
        assert!(ctx.sender() == task.provider, ENotProvider);
        assert_dispute_window_open(task, clock.timestamp_ms());

        if (task.payment_scheme == SCHEME_EXACT) {
            let provider = task.provider;
            let released_amount = release_escrow(task, provider, ctx);
            task.status = STATUS_RELEASED;
            reputation::record_payment(provider_card, released_amount);
            emit_payment_released_event(task, ctx.sender(), 0);
        } else {
            assert_metered_scheme(task);
            let (released_amount, refund_amount) = release_metered_amounts(task, ctx);
            task.status = STATUS_RELEASED;
            reputation::record_payment(provider_card, released_amount);
            emit_payment_released_event(task, ctx.sender(), refund_amount);
        };
    }

    public fun cancel_task<T>(task: &mut Task<T>, ctx: &mut TxContext) {
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

    public fun refund_expired_task<T>(task: &mut Task<T>, clock: &Clock, ctx: &mut TxContext) {
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

    public fun dispute_task<T>(task: &mut Task<T>, clock: &Clock, ctx: &mut TxContext) {
        assert!(task.status == STATUS_COMPLETED, ENotCompleted);
        assert!(ctx.sender() == task.requester, ENotRequester);
        assert_dispute_window_not_closed(task, clock.timestamp_ms());

        set_disputed(task);
        emit_disputed_event(task, clock.timestamp_ms());
    }

    public fun verify_result_hash<T>(task: &Task<T>, expected_hash: vector<u8>): bool {
        vector_equals(&task.verification_hash, &expected_hash)
    }

    public fun task_id<T>(task: &Task<T>): ID { object::id(task) }
    public fun task_requester<T>(task: &Task<T>): address { task.requester }
    public fun task_provider<T>(task: &Task<T>): address { task.provider }
    public fun task_capability<T>(task: &Task<T>): String { task.capability }
    public fun task_category<T>(task: &Task<T>): String { task.category }
    public fun task_input_blob_id<T>(task: &Task<T>): vector<u8> { task.input_blob_id }
    public fun task_result_blob_id<T>(task: &Task<T>): vector<u8> { task.result_blob_id }
    public fun task_agreement_hash<T>(task: &Task<T>): vector<u8> { task.agreement_hash }
    public fun task_price<T>(task: &Task<T>): u64 { task.price }
    public fun task_payment_scheme<T>(task: &Task<T>): u8 { task.payment_scheme }
    public fun task_max_price<T>(task: &Task<T>): u64 { task.max_price }
    public fun task_metered_units<T>(task: &Task<T>): u64 { task.metered_units }
    public fun task_unit_price<T>(task: &Task<T>): u64 { task.unit_price }
    public fun task_verification_hash<T>(task: &Task<T>): vector<u8> { task.verification_hash }
    public fun task_status<T>(task: &Task<T>): u8 { task.status }
    public fun task_dispute_window_ms<T>(task: &Task<T>): u64 { task.dispute_window_ms }
    public fun task_expires_at<T>(task: &Task<T>): u64 { task.expires_at }
    public fun task_created_at<T>(task: &Task<T>): u64 { task.created_at }
    public fun task_accepted_at<T>(task: &Task<T>): u64 { task.accepted_at }
    public fun task_completed_at<T>(task: &Task<T>): u64 { task.completed_at }
    public fun task_escrow_value<T>(task: &Task<T>): u64 { balance::value(&task.escrow) }

    public fun status_open(): u8 { STATUS_OPEN }
    public fun status_accepted(): u8 { STATUS_ACCEPTED }
    public fun status_completed(): u8 { STATUS_COMPLETED }
    public fun status_released(): u8 { STATUS_RELEASED }
    public fun status_disputed(): u8 { STATUS_DISPUTED }
    public fun status_cancelled(): u8 { STATUS_CANCELLED }

    public fun scheme_exact(): u8 { SCHEME_EXACT }
    public fun scheme_upto(): u8 { SCHEME_UPTO }
    public fun scheme_stream(): u8 { SCHEME_STREAM }

    public fun posted_event_task_id(event: &TaskPosted): ID { event.task_id }
    public fun posted_event_requester(event: &TaskPosted): address { event.requester }
    public fun posted_event_provider(event: &TaskPosted): address { event.provider }
    public fun posted_event_capability(event: &TaskPosted): String { event.capability }
    public fun posted_event_category(event: &TaskPosted): String { event.category }
    public fun posted_event_input_blob_id(event: &TaskPosted): vector<u8> { event.input_blob_id }
    public fun posted_event_agreement_hash(event: &TaskPosted): vector<u8> { event.agreement_hash }
    public fun posted_event_price(event: &TaskPosted): u64 { event.price }
    public fun posted_event_payment_scheme(event: &TaskPosted): u8 { event.payment_scheme }
    public fun posted_event_max_price(event: &TaskPosted): u64 { event.max_price }
    public fun posted_event_unit_price(event: &TaskPosted): u64 { event.unit_price }
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
    public fun completed_event_payment_scheme(event: &TaskCompleted): u8 { event.payment_scheme }
    public fun completed_event_metered_units(event: &TaskCompleted): u64 { event.metered_units }
    public fun completed_event_verification_hash(event: &TaskCompleted): vector<u8> { event.verification_hash }
    public fun completed_event_status(event: &TaskCompleted): u8 { event.status }
    public fun completed_event_completed_at(event: &TaskCompleted): u64 { event.completed_at }

    public fun payment_released_event_task_id(event: &TaskPaymentReleased): ID { event.task_id }
    public fun payment_released_event_provider(event: &TaskPaymentReleased): address { event.provider }
    public fun payment_released_event_price(event: &TaskPaymentReleased): u64 { event.price }
    public fun payment_released_event_refund_amount(event: &TaskPaymentReleased): u64 { event.refund_amount }
    public fun payment_released_event_status(event: &TaskPaymentReleased): u8 { event.status }
    public fun payment_released_event_released_by(event: &TaskPaymentReleased): address { event.released_by }

    public fun disputed_event_status(event: &TaskDisputed): u8 { event.status }
    public fun cancelled_event_refund_amount(event: &TaskCancelled): u64 { event.refund_amount }
    public fun expired_refund_event_refunded_by(event: &TaskExpiredRefunded): address { event.refunded_by }
    public fun expired_refund_event_refund_amount(event: &TaskExpiredRefunded): u64 { event.refund_amount }
}
