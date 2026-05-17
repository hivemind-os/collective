#[allow(unused_const)]
module agentic_mesh::staking {
    use agentic_mesh::task::{Self as task, Task};
    use sui::balance::{Self as balance, Balance};
    use sui::clock::Clock;
    use sui::coin::{Self as coin, Coin};
    use sui::event;
    use sui::sui::SUI;

    const AGENT_STAKE: u8 = 0;
    const RELAY_STAKE: u8 = 1;
    const EVIDENCE_EXPIRED_ESCROW: u8 = 0;
    const EVIDENCE_NON_DELIVERY: u8 = 1;

    const AGENT_MIN_STAKE: u64 = 10_000_000_000;
    const RELAY_MIN_STAKE: u64 = 100_000_000_000;
    const COOLDOWN_MS: u64 = 604_800_000;

    const E_INSUFFICIENT_STAKE: u64 = 1;
    const E_NOT_OWNER: u64 = 2;
    const E_COOLDOWN_NOT_EXPIRED: u64 = 3;
    const E_ALREADY_STAKED: u64 = 4;
    const E_NOT_STAKED: u64 = 5;
    const E_INVALID_EVIDENCE: u64 = 6;
    const E_ALREADY_SLASHED: u64 = 7;
    const E_SLASH_EXCEEDS_STAKE: u64 = 8;
    const E_NOT_REQUESTER: u64 = 9;

    public struct StakePosition has key, store {
        id: UID,
        owner: address,
        stake_type: u8,
        balance: Balance<SUI>,
        staked_at: u64,
        deactivated_at: u64,
        slashed_amount: u64,
        slashed_tasks: vector<ID>,
    }

    public struct SlashRecord has key, store {
        id: UID,
        target: address,
        evidence_type: u8,
        task_id: ID,
        amount: u64,
        timestamp: u64,
    }

    public struct StakeDeposited has copy, drop {
        stake_id: ID,
        owner: address,
        amount: u64,
        stake_type: u8,
    }

    public struct StakeWithdrawn has copy, drop {
        stake_id: ID,
        owner: address,
        amount: u64,
    }

    public struct StakeSlashed has copy, drop {
        stake_id: ID,
        target: address,
        amount: u64,
        evidence_type: u8,
        task_id: ID,
    }

    public struct DeactivationStarted has copy, drop {
        stake_id: ID,
        owner: address,
        cooldown_ends_at: u64,
    }

    public fun deposit_stake(
        payment: Coin<SUI>,
        stake_type: u8,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let amount = coin::value(&payment);
        assert!(amount >= minimum_for_type(stake_type), E_INSUFFICIENT_STAKE);

        let position = StakePosition {
            id: object::new(ctx),
            owner: ctx.sender(),
            stake_type,
            balance: coin::into_balance(payment),
            staked_at: clock.timestamp_ms(),
            deactivated_at: 0,
            slashed_amount: 0,
            slashed_tasks: vector[],
        };

        event::emit(StakeDeposited {
            stake_id: object::id(&position),
            owner: position.owner,
            amount,
            stake_type: position.stake_type,
        });

        transfer::share_object(position);
    }

    public fun add_stake(
        position: &mut StakePosition,
        payment: Coin<SUI>,
        ctx: &TxContext,
    ) {
        assert!(position.owner == ctx.sender(), E_NOT_OWNER);
        let amount = coin::value(&payment);
        balance::join(&mut position.balance, coin::into_balance(payment));
        if (position.deactivated_at != 0) {
            position.deactivated_at = 0;
        };

        event::emit(StakeDeposited {
            stake_id: object::id(position),
            owner: position.owner,
            amount,
            stake_type: position.stake_type,
        });
    }

    public fun start_deactivation(
        position: &mut StakePosition,
        clock: &Clock,
        ctx: &TxContext,
    ) {
        assert!(position.owner == ctx.sender(), E_NOT_OWNER);
        if (position.deactivated_at == 0) {
            position.deactivated_at = clock.timestamp_ms();
            event::emit(DeactivationStarted {
                stake_id: object::id(position),
                owner: position.owner,
                cooldown_ends_at: position.deactivated_at + COOLDOWN_MS,
            });
        };
    }

    public fun withdraw_stake(
        position: StakePosition,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(position.owner == ctx.sender(), E_NOT_OWNER);
        assert!(position.deactivated_at != 0, E_NOT_STAKED);
        assert!(clock.timestamp_ms() >= position.deactivated_at + COOLDOWN_MS, E_COOLDOWN_NOT_EXPIRED);

        let stake_id = object::id(&position);
        let amount = balance::value(&position.balance);
        let owner = position.owner;
        let StakePosition {
            id,
            owner: _,
            stake_type: _,
            balance,
            staked_at: _,
            deactivated_at: _,
            slashed_amount: _,
            slashed_tasks: _,
        } = position;
        id.delete();

        let payment = coin::from_balance(balance, ctx);
        transfer::public_transfer(payment, owner);
        event::emit(StakeWithdrawn {
            stake_id,
            owner,
            amount,
        });
    }

    public fun slash_expired_escrow(
        position: &mut StakePosition,
        task_ref: &Task<SUI>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        slash(position, task_ref, EVIDENCE_EXPIRED_ESCROW, clock, ctx);
    }

    public fun slash_non_delivery(
        position: &mut StakePosition,
        task_ref: &Task<SUI>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        slash(position, task_ref, EVIDENCE_NON_DELIVERY, clock, ctx);
    }

    fun slash(
        position: &mut StakePosition,
        task_ref: &Task<SUI>,
        evidence_type: u8,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(ctx.sender() == task::task_requester(task_ref), E_NOT_REQUESTER);
        assert!(is_valid_evidence(position, task_ref, clock), E_INVALID_EVIDENCE);

        let task_id = task::task_id(task_ref);
        assert!(!has_slashed_task(position, task_id), E_ALREADY_SLASHED);

        let available = balance::value(&position.balance);
        assert!(available > 0, E_SLASH_EXCEEDS_STAKE);

        let escrow_amount = task::task_escrow_value(task_ref);
        let slash_amount = if (escrow_amount < available) { escrow_amount } else { available };
        let slashed_balance = balance::split(&mut position.balance, slash_amount);
        let slashed_coin = coin::from_balance(slashed_balance, ctx);
        transfer::public_transfer(slashed_coin, ctx.sender());

        position.slashed_amount = position.slashed_amount + slash_amount;
        position.slashed_tasks.push_back(task_id);

        let record = SlashRecord {
            id: object::new(ctx),
            target: position.owner,
            evidence_type,
            task_id,
            amount: slash_amount,
            timestamp: clock.timestamp_ms(),
        };

        event::emit(StakeSlashed {
            stake_id: object::id(position),
            target: position.owner,
            amount: slash_amount,
            evidence_type,
            task_id,
        });

        transfer::transfer(record, ctx.sender());
    }

    fun is_valid_evidence(position: &StakePosition, task_ref: &Task<SUI>, clock: &Clock): bool {
        if (task::task_provider(task_ref) != position.owner) {
            return false
        };
        if (task::task_status(task_ref) != task::status_accepted()) {
            return false
        };
        if (clock.timestamp_ms() < task::task_expires_at(task_ref)) {
            return false
        };
        let accepted_at = task::task_accepted_at(task_ref);
        if (accepted_at == 0 || position.staked_at > accepted_at) {
            return false
        };
        true
    }

    fun has_slashed_task(position: &StakePosition, task_id: ID): bool {
        let mut i = 0;
        while (i < position.slashed_tasks.length()) {
            if (*position.slashed_tasks.borrow(i) == task_id) {
                return true
            };
            i = i + 1;
        };
        false
    }

    fun minimum_for_type(stake_type: u8): u64 {
        if (stake_type == AGENT_STAKE) {
            AGENT_MIN_STAKE
        } else {
            assert!(stake_type == RELAY_STAKE, E_INSUFFICIENT_STAKE);
            RELAY_MIN_STAKE
        }
    }

    public fun get_stake_amount(position: &StakePosition): u64 {
        balance::value(&position.balance)
    }

    public fun is_active(position: &StakePosition): bool {
        position.deactivated_at == 0 && meets_minimum(position)
    }

    public fun cooldown_remaining(position: &StakePosition, clock: &Clock): u64 {
        if (position.deactivated_at == 0) {
            return 0
        };
        let cooldown_ends_at = position.deactivated_at + COOLDOWN_MS;
        if (clock.timestamp_ms() >= cooldown_ends_at) {
            0
        } else {
            cooldown_ends_at - clock.timestamp_ms()
        }
    }

    public fun meets_minimum(position: &StakePosition): bool {
        get_stake_amount(position) >= minimum_for_type(position.stake_type)
    }

    public fun agent_stake_type(): u8 { AGENT_STAKE }
    public fun relay_stake_type(): u8 { RELAY_STAKE }
    public fun expired_escrow_evidence_type(): u8 { EVIDENCE_EXPIRED_ESCROW }
    public fun non_delivery_evidence_type(): u8 { EVIDENCE_NON_DELIVERY }
    public fun agent_min_stake(): u64 { AGENT_MIN_STAKE }
    public fun relay_min_stake(): u64 { RELAY_MIN_STAKE }
    public fun cooldown_ms(): u64 { COOLDOWN_MS }

    public fun stake_id(position: &StakePosition): ID { object::id(position) }
    public fun stake_owner(position: &StakePosition): address { position.owner }
    public fun stake_type(position: &StakePosition): u8 { position.stake_type }
    public fun stake_staked_at(position: &StakePosition): u64 { position.staked_at }
    public fun stake_deactivated_at(position: &StakePosition): u64 { position.deactivated_at }
    public fun stake_slashed_amount(position: &StakePosition): u64 { position.slashed_amount }

    public fun slash_record_id(record: &SlashRecord): ID { object::id(record) }
    public fun slash_record_target(record: &SlashRecord): address { record.target }
    public fun slash_record_evidence_type(record: &SlashRecord): u8 { record.evidence_type }
    public fun slash_record_task_id(record: &SlashRecord): ID { record.task_id }
    public fun slash_record_amount(record: &SlashRecord): u64 { record.amount }
    public fun slash_record_timestamp(record: &SlashRecord): u64 { record.timestamp }

    public fun deposited_event_stake_id(event: &StakeDeposited): ID { event.stake_id }
    public fun deposited_event_owner(event: &StakeDeposited): address { event.owner }
    public fun deposited_event_amount(event: &StakeDeposited): u64 { event.amount }
    public fun deposited_event_stake_type(event: &StakeDeposited): u8 { event.stake_type }

    public fun withdrawn_event_stake_id(event: &StakeWithdrawn): ID { event.stake_id }
    public fun withdrawn_event_owner(event: &StakeWithdrawn): address { event.owner }
    public fun withdrawn_event_amount(event: &StakeWithdrawn): u64 { event.amount }

    public fun slashed_event_stake_id(event: &StakeSlashed): ID { event.stake_id }
    public fun slashed_event_target(event: &StakeSlashed): address { event.target }
    public fun slashed_event_amount(event: &StakeSlashed): u64 { event.amount }
    public fun slashed_event_evidence_type(event: &StakeSlashed): u8 { event.evidence_type }
    public fun slashed_event_task_id(event: &StakeSlashed): ID { event.task_id }

    public fun deactivation_event_stake_id(event: &DeactivationStarted): ID { event.stake_id }
    public fun deactivation_event_owner(event: &DeactivationStarted): address { event.owner }
    public fun deactivation_event_cooldown_ends_at(event: &DeactivationStarted): u64 { event.cooldown_ends_at }
}
