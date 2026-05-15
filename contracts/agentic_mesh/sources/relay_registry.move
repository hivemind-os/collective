module agentic_mesh::relay_registry {
    use agentic_mesh::staking::{Self as staking, StakePosition};
    use std::string::String;
    use sui::clock::Clock;
    use sui::event;

    const STATUS_ACTIVE: u8 = 0;
    const STATUS_INACTIVE: u8 = 1;
    const STATUS_SLASHED: u8 = 2;

    const MAX_ROUTING_FEE_BPS: u64 = 10_000;

    const E_NOT_OPERATOR: u64 = 1;
    const E_INVALID_STAKE_TYPE: u64 = 2;
    const E_INSUFFICIENT_STAKE: u64 = 3;
    const E_INVALID_ROUTING_FEE: u64 = 4;
    const E_RELAY_NOT_ACTIVE: u64 = 5;
    const E_RELAY_ALREADY_SLASHED: u64 = 6;

    public struct RelayNode has key, store {
        id: UID,
        operator: address,
        endpoint: String,
        stake_position_id: ID,
        capabilities: vector<String>,
        region: String,
        status: u8,
        registered_at: u64,
        last_heartbeat: u64,
        routing_fee_bps: u64,
        total_routed: u64,
        total_fees_earned: u64,
    }

    public struct RelayRegistered has copy, drop {
        relay_id: ID,
        operator: address,
        endpoint: String,
        stake_position_id: ID,
        capabilities: vector<String>,
        region: String,
        status: u8,
        registered_at: u64,
        last_heartbeat: u64,
        routing_fee_bps: u64,
    }

    public struct RelayDeactivated has copy, drop {
        relay_id: ID,
        operator: address,
        status: u8,
    }

    public struct RelayHeartbeat has copy, drop {
        relay_id: ID,
        operator: address,
        last_heartbeat: u64,
    }

    public struct RelaySlashed has copy, drop {
        relay_id: ID,
        operator: address,
        status: u8,
    }

    public fun register_relay(
        endpoint: String,
        stake_position: &StakePosition,
        capabilities: vector<String>,
        region: String,
        routing_fee_bps: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(staking::stake_owner(stake_position) == ctx.sender(), E_NOT_OPERATOR);
        assert!(staking::stake_type(stake_position) == staking::relay_stake_type(), E_INVALID_STAKE_TYPE);
        assert!(staking::meets_minimum(stake_position), E_INSUFFICIENT_STAKE);
        assert!(routing_fee_bps <= MAX_ROUTING_FEE_BPS, E_INVALID_ROUTING_FEE);

        let timestamp = clock.timestamp_ms();
        let relay = RelayNode {
            id: object::new(ctx),
            operator: ctx.sender(),
            endpoint,
            stake_position_id: staking::stake_id(stake_position),
            capabilities,
            region,
            status: STATUS_ACTIVE,
            registered_at: timestamp,
            last_heartbeat: timestamp,
            routing_fee_bps,
            total_routed: 0,
            total_fees_earned: 0,
        };

        event::emit(RelayRegistered {
            relay_id: object::id(&relay),
            operator: relay.operator,
            endpoint: relay.endpoint,
            stake_position_id: relay.stake_position_id,
            capabilities: relay.capabilities,
            region: relay.region,
            status: relay.status,
            registered_at: relay.registered_at,
            last_heartbeat: relay.last_heartbeat,
            routing_fee_bps: relay.routing_fee_bps,
        });

        transfer::share_object(relay);
    }

    public fun heartbeat(relay: &mut RelayNode, clock: &Clock, ctx: &TxContext) {
        assert!(relay.operator == ctx.sender(), E_NOT_OPERATOR);
        assert!(relay.status == STATUS_ACTIVE, E_RELAY_NOT_ACTIVE);

        relay.last_heartbeat = clock.timestamp_ms();
        event::emit(RelayHeartbeat {
            relay_id: object::id(relay),
            operator: relay.operator,
            last_heartbeat: relay.last_heartbeat,
        });
    }

    public(package) fun record_routing(relay: &mut RelayNode, fee_amount: u64, ctx: &TxContext) {
        assert!(relay.operator == ctx.sender(), E_NOT_OPERATOR);
        assert!(relay.status == STATUS_ACTIVE, E_RELAY_NOT_ACTIVE);

        relay.total_routed = relay.total_routed + 1;
        relay.total_fees_earned = relay.total_fees_earned + fee_amount;
    }

    public fun deactivate_relay(relay: &mut RelayNode, ctx: &TxContext) {
        assert!(relay.operator == ctx.sender(), E_NOT_OPERATOR);
        assert!(relay.status == STATUS_ACTIVE, E_RELAY_NOT_ACTIVE);

        relay.status = STATUS_INACTIVE;
        event::emit(RelayDeactivated {
            relay_id: object::id(relay),
            operator: relay.operator,
            status: relay.status,
        });
    }

    public(package) fun slash_relay(relay: &mut RelayNode) {
        assert!(relay.status != STATUS_SLASHED, E_RELAY_ALREADY_SLASHED);

        relay.status = STATUS_SLASHED;
        event::emit(RelaySlashed {
            relay_id: object::id(relay),
            operator: relay.operator,
            status: relay.status,
        });
    }

    public fun relay_id(relay: &RelayNode): ID { object::id(relay) }
    public fun relay_operator(relay: &RelayNode): address { relay.operator }
    public fun relay_endpoint(relay: &RelayNode): String { relay.endpoint }
    public fun relay_stake_position_id(relay: &RelayNode): ID { relay.stake_position_id }
    public fun relay_capabilities(relay: &RelayNode): vector<String> { relay.capabilities }
    public fun relay_region(relay: &RelayNode): String { relay.region }
    public fun relay_status(relay: &RelayNode): u8 { relay.status }
    public fun relay_registered_at(relay: &RelayNode): u64 { relay.registered_at }
    public fun relay_last_heartbeat(relay: &RelayNode): u64 { relay.last_heartbeat }
    public fun relay_routing_fee_bps(relay: &RelayNode): u64 { relay.routing_fee_bps }
    public fun relay_total_routed(relay: &RelayNode): u64 { relay.total_routed }
    public fun relay_total_fees_earned(relay: &RelayNode): u64 { relay.total_fees_earned }

    public fun status_active(): u8 { STATUS_ACTIVE }
    public fun status_inactive(): u8 { STATUS_INACTIVE }
    public fun status_slashed(): u8 { STATUS_SLASHED }
    public fun max_routing_fee_bps(): u64 { MAX_ROUTING_FEE_BPS }

    public fun registered_event_relay_id(event: &RelayRegistered): ID { event.relay_id }
    public fun registered_event_operator(event: &RelayRegistered): address { event.operator }
    public fun registered_event_endpoint(event: &RelayRegistered): String { event.endpoint }
    public fun registered_event_stake_position_id(event: &RelayRegistered): ID { event.stake_position_id }
    public fun registered_event_capabilities(event: &RelayRegistered): vector<String> { event.capabilities }
    public fun registered_event_region(event: &RelayRegistered): String { event.region }
    public fun registered_event_status(event: &RelayRegistered): u8 { event.status }
    public fun registered_event_registered_at(event: &RelayRegistered): u64 { event.registered_at }
    public fun registered_event_last_heartbeat(event: &RelayRegistered): u64 { event.last_heartbeat }
    public fun registered_event_routing_fee_bps(event: &RelayRegistered): u64 { event.routing_fee_bps }

    public fun deactivated_event_relay_id(event: &RelayDeactivated): ID { event.relay_id }
    public fun deactivated_event_operator(event: &RelayDeactivated): address { event.operator }
    public fun deactivated_event_status(event: &RelayDeactivated): u8 { event.status }

    public fun heartbeat_event_relay_id(event: &RelayHeartbeat): ID { event.relay_id }
    public fun heartbeat_event_operator(event: &RelayHeartbeat): address { event.operator }
    public fun heartbeat_event_last_heartbeat(event: &RelayHeartbeat): u64 { event.last_heartbeat }

    public fun slashed_event_relay_id(event: &RelaySlashed): ID { event.relay_id }
    public fun slashed_event_operator(event: &RelaySlashed): address { event.operator }
    public fun slashed_event_status(event: &RelaySlashed): u8 { event.status }
}
