#[allow(lint(self_transfer))]
module agentic_mesh::registry {
    use std::string::{Self, String};
    use sui::clock::Clock;
    use sui::event;
    use sui::table::{Self, Table};

    const EAlreadyRegistered: u64 = 0;
    const ENotRegistered: u64 = 1;
    const ENotOwner: u64 = 2;
    const ENotActive: u64 = 3;
    const ECapabilityLengthMismatch: u64 = 4;
    const EAlreadyActive: u64 = 5;
    const EInvalidEncryptionKeyLength: u64 = 6;

    public struct Registry has key {
        id: UID,
        agents: Table<address, ID>,
        active_count: u64,
    }

    public struct AgentCard has key, store {
        id: UID,
        owner: address,
        did: String,
        name: String,
        description: String,
        capabilities: vector<Capability>,
        endpoint: String,
        encryption_public_key: vector<u8>,
        active: bool,
        version: u64,
        registered_at: u64,
        updated_at: u64,
        total_tasks_completed: u64,
        total_tasks_failed: u64,
        total_tasks_disputed: u64,
        total_earnings_mist: u64,
    }

    public struct Capability has store, copy, drop {
        name: String,
        description: String,
        version: String,
        price_mist: u64,
        currency: String,
    }

    public struct AgentRegistered has copy, drop {
        agent: address,
        card_id: ID,
        did: String,
        name: String,
        description: String,
        capabilities: vector<Capability>,
        endpoint: String,
        encryption_public_key: vector<u8>,
        active: bool,
        version: u64,
        registered_at: u64,
        updated_at: u64,
        total_tasks_completed: u64,
        total_tasks_failed: u64,
        total_tasks_disputed: u64,
        total_earnings_mist: u64,
    }

    public struct AgentUpdated has copy, drop {
        agent: address,
        card_id: ID,
        did: String,
        name: String,
        description: String,
        capabilities: vector<Capability>,
        endpoint: String,
        encryption_public_key: vector<u8>,
        active: bool,
        version: u64,
        registered_at: u64,
        updated_at: u64,
        total_tasks_completed: u64,
        total_tasks_failed: u64,
        total_tasks_disputed: u64,
        total_earnings_mist: u64,
    }

    public struct AgentDeactivated has copy, drop {
        agent: address,
        card_id: ID,
        did: String,
        name: String,
        description: String,
        capabilities: vector<Capability>,
        endpoint: String,
        encryption_public_key: vector<u8>,
        active: bool,
        version: u64,
        registered_at: u64,
        updated_at: u64,
        total_tasks_completed: u64,
        total_tasks_failed: u64,
        total_tasks_disputed: u64,
        total_earnings_mist: u64,
    }

    fun init(ctx: &mut TxContext) {
        transfer::share_object(Registry {
            id: object::new(ctx),
            agents: table::new(ctx),
            active_count: 0,
        });
    }

    fun build_capabilities(
        cap_names: vector<String>,
        cap_descriptions: vector<String>,
        cap_versions: vector<String>,
        cap_prices: vector<u64>,
        cap_currencies: vector<String>,
    ): vector<Capability> {
        let len = cap_names.length();
        assert!(
            cap_descriptions.length() == len &&
                cap_versions.length() == len &&
                cap_prices.length() == len &&
                cap_currencies.length() == len,
            ECapabilityLengthMismatch,
        );

        let mut capabilities = vector[];
        let mut i = 0;
        while (i < len) {
            let mut currency = *cap_currencies.borrow(i);
            if (currency.is_empty()) {
                currency = string::utf8(b"SUI");
            };

            capabilities.push_back(Capability {
                name: *cap_names.borrow(i),
                description: *cap_descriptions.borrow(i),
                version: *cap_versions.borrow(i),
                price_mist: *cap_prices.borrow(i),
                currency,
            });
            i = i + 1;
        };

        capabilities
    }

    public fun register_agent(
        registry: &mut Registry,
        name: String,
        did: String,
        description: String,
        cap_names: vector<String>,
        cap_descriptions: vector<String>,
        cap_versions: vector<String>,
        cap_prices: vector<u64>,
        cap_currencies: vector<String>,
        endpoint: String,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let sender = ctx.sender();
        assert!(!registry.agents.contains(sender), EAlreadyRegistered);

        let timestamp = clock.timestamp_ms();
        let capabilities = build_capabilities(
            cap_names,
            cap_descriptions,
            cap_versions,
            cap_prices,
            cap_currencies,
        );
        let card = AgentCard {
            id: object::new(ctx),
            owner: sender,
            did,
            name,
            description,
            capabilities,
            endpoint,
            encryption_public_key: vector[],
            active: true,
            version: 1,
            registered_at: timestamp,
            updated_at: timestamp,
            total_tasks_completed: 0,
            total_tasks_failed: 0,
            total_tasks_disputed: 0,
            total_earnings_mist: 0,
        };

        let card_id = object::id(&card);
        registry.agents.add(sender, card_id);
        registry.active_count = registry.active_count + 1;

        event::emit(AgentRegistered {
            agent: sender,
            card_id,
            did: card.did,
            name: card.name,
            description: card.description,
            capabilities: card.capabilities,
            endpoint: card.endpoint,
            encryption_public_key: card.encryption_public_key,
            active: card.active,
            version: card.version,
            registered_at: card.registered_at,
            updated_at: card.updated_at,
            total_tasks_completed: card.total_tasks_completed,
            total_tasks_failed: card.total_tasks_failed,
            total_tasks_disputed: card.total_tasks_disputed,
            total_earnings_mist: card.total_earnings_mist,
        });

        transfer::transfer(card, sender);
    }

    public fun update_agent(
        registry: &Registry,
        card: &mut AgentCard,
        name: String,
        description: String,
        endpoint: String,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let sender = ctx.sender();
        assert!(card.owner == sender, ENotOwner);
        assert!(card.active, ENotActive);
        assert!(registry.agents.contains(sender), ENotRegistered);

        card.name = name;
        card.description = description;
        card.endpoint = endpoint;
        card.version = card.version + 1;
        card.updated_at = clock.timestamp_ms();

        event::emit(AgentUpdated {
            agent: sender,
            card_id: object::id(card),
            did: card.did,
            name: card.name,
            description: card.description,
            capabilities: card.capabilities,
            endpoint: card.endpoint,
            encryption_public_key: card.encryption_public_key,
            active: card.active,
            version: card.version,
            registered_at: card.registered_at,
            updated_at: card.updated_at,
            total_tasks_completed: card.total_tasks_completed,
            total_tasks_failed: card.total_tasks_failed,
            total_tasks_disputed: card.total_tasks_disputed,
            total_earnings_mist: card.total_earnings_mist,
        });
    }

    public fun update_capabilities(
        registry: &Registry,
        card: &mut AgentCard,
        cap_names: vector<String>,
        cap_descriptions: vector<String>,
        cap_versions: vector<String>,
        cap_prices: vector<u64>,
        cap_currencies: vector<String>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let sender = ctx.sender();
        assert!(card.owner == sender, ENotOwner);
        assert!(card.active, ENotActive);
        assert!(registry.agents.contains(sender), ENotRegistered);

        card.capabilities = build_capabilities(
            cap_names,
            cap_descriptions,
            cap_versions,
            cap_prices,
            cap_currencies,
        );
        card.version = card.version + 1;
        card.updated_at = clock.timestamp_ms();

        event::emit(AgentUpdated {
            agent: sender,
            card_id: object::id(card),
            did: card.did,
            name: card.name,
            description: card.description,
            capabilities: card.capabilities,
            endpoint: card.endpoint,
            encryption_public_key: card.encryption_public_key,
            active: card.active,
            version: card.version,
            registered_at: card.registered_at,
            updated_at: card.updated_at,
            total_tasks_completed: card.total_tasks_completed,
            total_tasks_failed: card.total_tasks_failed,
            total_tasks_disputed: card.total_tasks_disputed,
            total_earnings_mist: card.total_earnings_mist,
        });
    }

    public fun deactivate_agent(
        registry: &mut Registry,
        card: &mut AgentCard,
        ctx: &mut TxContext,
    ) {
        let sender = ctx.sender();
        assert!(card.owner == sender, ENotOwner);
        assert!(card.active, ENotActive);
        assert!(registry.agents.contains(sender), ENotRegistered);

        card.active = false;
        let _card_id = registry.agents.remove(sender);
        registry.active_count = registry.active_count - 1;

        event::emit(AgentDeactivated {
            agent: sender,
            card_id: object::id(card),
            did: card.did,
            name: card.name,
            description: card.description,
            capabilities: card.capabilities,
            endpoint: card.endpoint,
            encryption_public_key: card.encryption_public_key,
            active: card.active,
            version: card.version,
            registered_at: card.registered_at,
            updated_at: card.updated_at,
            total_tasks_completed: card.total_tasks_completed,
            total_tasks_failed: card.total_tasks_failed,
            total_tasks_disputed: card.total_tasks_disputed,
            total_earnings_mist: card.total_earnings_mist,
        });
    }

    public fun reactivate_agent(
        registry: &mut Registry,
        card: &mut AgentCard,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let sender = ctx.sender();
        assert!(card.owner == sender, ENotOwner);
        assert!(!card.active, EAlreadyActive);
        assert!(!registry.agents.contains(sender), EAlreadyRegistered);

        card.active = true;
        card.version = card.version + 1;
        card.updated_at = clock.timestamp_ms();

        let card_id = object::id(card);
        registry.agents.add(sender, card_id);
        registry.active_count = registry.active_count + 1;

        event::emit(AgentUpdated {
            agent: sender,
            card_id,
            did: card.did,
            name: card.name,
            description: card.description,
            capabilities: card.capabilities,
            endpoint: card.endpoint,
            encryption_public_key: card.encryption_public_key,
            active: card.active,
            version: card.version,
            registered_at: card.registered_at,
            updated_at: card.updated_at,
            total_tasks_completed: card.total_tasks_completed,
            total_tasks_failed: card.total_tasks_failed,
            total_tasks_disputed: card.total_tasks_disputed,
            total_earnings_mist: card.total_earnings_mist,
        });
    }

    public entry fun set_encryption_key(
        card: &mut AgentCard,
        encryption_public_key: vector<u8>,
        ctx: &TxContext,
    ) {
        let sender = ctx.sender();
        let key_length = encryption_public_key.length();
        assert!(card.owner == sender, ENotOwner);
        assert!(key_length == 0 || key_length == 32, EInvalidEncryptionKeyLength);

        card.encryption_public_key = encryption_public_key;
    }

    public(package) fun increment_completed(card: &mut AgentCard) {
        card.total_tasks_completed = card.total_tasks_completed + 1;
    }

    public(package) fun increment_failed(card: &mut AgentCard) {
        card.total_tasks_failed = card.total_tasks_failed + 1;
    }

    public(package) fun increment_disputed(card: &mut AgentCard) {
        card.total_tasks_disputed = card.total_tasks_disputed + 1;
    }

    public(package) fun add_earnings(card: &mut AgentCard, amount: u64) {
        card.total_earnings_mist = card.total_earnings_mist + amount;
    }

    public fun active_count(registry: &Registry): u64 { registry.active_count }
    public fun is_registered(registry: &Registry, agent: address): bool { registry.agents.contains(agent) }

    public fun card_id(card: &AgentCard): ID { object::id(card) }
    public fun card_owner(card: &AgentCard): address { card.owner }
    public fun card_did(card: &AgentCard): String { card.did }
    public fun card_name(card: &AgentCard): String { card.name }
    public fun card_description(card: &AgentCard): String { card.description }
    public fun card_capabilities(card: &AgentCard): vector<Capability> { card.capabilities }
    public fun card_endpoint(card: &AgentCard): String { card.endpoint }
    public fun card_encryption_public_key(card: &AgentCard): vector<u8> { card.encryption_public_key }
    public fun card_active(card: &AgentCard): bool { card.active }
    public fun card_version(card: &AgentCard): u64 { card.version }
    public fun card_registered_at(card: &AgentCard): u64 { card.registered_at }
    public fun card_updated_at(card: &AgentCard): u64 { card.updated_at }
    public fun card_total_tasks_completed(card: &AgentCard): u64 { card.total_tasks_completed }
    public fun card_total_tasks_failed(card: &AgentCard): u64 { card.total_tasks_failed }
    public fun card_total_tasks_disputed(card: &AgentCard): u64 { card.total_tasks_disputed }
    public fun card_total_earnings_mist(card: &AgentCard): u64 { card.total_earnings_mist }

    public fun capability_name(capability: &Capability): String { capability.name }
    public fun capability_description(capability: &Capability): String { capability.description }
    public fun capability_version(capability: &Capability): String { capability.version }
    public fun capability_price_mist(capability: &Capability): u64 { capability.price_mist }
    public fun capability_currency(capability: &Capability): String { capability.currency }

    public fun registered_event_agent(event: &AgentRegistered): address { event.agent }
    public fun registered_event_card_id(event: &AgentRegistered): ID { event.card_id }
    public fun registered_event_did(event: &AgentRegistered): String { event.did }
    public fun registered_event_name(event: &AgentRegistered): String { event.name }
    public fun registered_event_description(event: &AgentRegistered): String { event.description }
    public fun registered_event_capabilities(event: &AgentRegistered): vector<Capability> { event.capabilities }
    public fun registered_event_endpoint(event: &AgentRegistered): String { event.endpoint }
    public fun registered_event_encryption_public_key(event: &AgentRegistered): vector<u8> { event.encryption_public_key }
    public fun registered_event_active(event: &AgentRegistered): bool { event.active }
    public fun registered_event_version(event: &AgentRegistered): u64 { event.version }
    public fun registered_event_registered_at(event: &AgentRegistered): u64 { event.registered_at }
    public fun registered_event_updated_at(event: &AgentRegistered): u64 { event.updated_at }

    public fun updated_event_agent(event: &AgentUpdated): address { event.agent }
    public fun updated_event_card_id(event: &AgentUpdated): ID { event.card_id }
    public fun updated_event_name(event: &AgentUpdated): String { event.name }
    public fun updated_event_description(event: &AgentUpdated): String { event.description }
    public fun updated_event_capabilities(event: &AgentUpdated): vector<Capability> { event.capabilities }
    public fun updated_event_endpoint(event: &AgentUpdated): String { event.endpoint }
    public fun updated_event_active(event: &AgentUpdated): bool { event.active }
    public fun updated_event_version(event: &AgentUpdated): u64 { event.version }
    public fun updated_event_updated_at(event: &AgentUpdated): u64 { event.updated_at }

    public fun deactivated_event_agent(event: &AgentDeactivated): address { event.agent }
    public fun deactivated_event_card_id(event: &AgentDeactivated): ID { event.card_id }
    public fun deactivated_event_active(event: &AgentDeactivated): bool { event.active }
    public fun deactivated_event_version(event: &AgentDeactivated): u64 { event.version }
    public fun deactivated_event_updated_at(event: &AgentDeactivated): u64 { event.updated_at }

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        init(ctx);
    }
}