import Array "mo:core/Array";
import Char "mo:core/Char";
import Int "mo:core/Int";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Text "mo:core/Text";
import Time "mo:core/Time";
import NeutronCapabilities "mo:neutron-capabilities";
import Memory "./memory/subz/v1";

module {

    public type TaskCapabilities = {
        backend_calls : NeutronCapabilities.BackendCallsV1;
    };

    public type SubscriptionMeta = {
        id : Text;
        name : Text;
        cost : Text;
        category : Text;
        funded : Bool;
        cancel_url : Text;
        has_note : Bool;
        note_bytes : Nat;
        renew_days : Nat;
        pot_e8s : Nat;
        payee : Text;
        created_at : Int;
        expires_at : Int;
        seconds_left : Int;
    };

    public type PurgeEventView = {
        id : Text;
        name : Text;
        purged_at : Int;
        reason : Text;
    };

    public type SeatView = {
        member : Text;
        paid : Bool;
    };

    public type SplitJoinInput = {
        session_id : Text;
        member : Text;
    };

    public type AddSubscriptionInput = {
        id : Text;
        name : Text;
        cost : Text;
        category : Text;
        funded : Bool;
        cancel_url : Text;
        note_ciphertext : ?Blob;
        renew_days : Nat;
    };

    public type UpdateSubscriptionInput = {
        id : Text;
        name : Text;
        cost : Text;
        category : Text;
        cancel_url : Text;
        renew_days : Nat;
    };

    public type IcrcAccount = {
        owner : Principal;
        subaccount : ?Blob;
    };

    public type IcrcTransferArgs = {
        from_subaccount : ?Blob;
        to : IcrcAccount;
        amount : Nat;
        fee : ?Nat;
        memo : ?Blob;
        created_at_time : ?Nat64;
    };

    public type IcrcTransferResult = {
        #Ok : Nat;
        #Err : {
            #BadFee : { expected_fee : Nat };
            #InsufficientFunds : { balance : Nat };
            #GenericError : { error_code : Nat; message : Text };
            #TemporarilyUnavailable;
            #Duplicate : { duplicate_of : Nat };
            #BadBurn : { min_burn_amount : Nat };
            #CreatedInFuture : { ledger_time : Nat64 };
            #TooOld;
            #GenericBatchError : { error_code : Nat; message : Text };
        };
    };

    public type PayResult = {
        ok : Bool;
        message : Text;
        block_index : ?Nat;
        pot_e8s : Nat;
    };

    public type BalanceView = {
        ok : Bool;
        message : Text;
        balance_e8s : Nat;
    };

    public type SessionView = {
        id : Text;
        sub_id : Text;
        sub_name : Text;
        seats : [SeatView];
        open : Bool;
        created_at : Int;
    };

    public type Status = {
        subscription_count : Nat;
        auto_delete : Bool;
        monitor_runs : Nat;
        purge_count : Nat;
        next_expiry_in : ?Int;
        monthly_budget : Text;
    };

    public type Receipt = {
        ok : Bool;
        error : Text;
        assertion_text : Text;
        signature_hex : Text;
    };

    public type AppBackendEnvironment = {
        stable_memory : {
            subz : Memory.Mem;
        };
        capabilities : {
            backend_calls : NeutronCapabilities.BackendCallsV1;
            chain_key_signing : NeutronCapabilities.ChainKeySigningV1;
        };
    };

    public class Init(env : AppBackendEnvironment) {
        let mem = env.stable_memory.subz;
        let chainKeySigning = env.capabilities.chain_key_signing;
        let backendCalls = env.capabilities.backend_calls;

        // ICP ledger: the same principal resolves on mainnet and on the local
        // full_protocol_fixtures profile.
        let ICP_LEDGER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
        let LEDGER_FEE_E8S : Nat = 10_000;
        let MAX_PAYEE_BYTES : Nat = 128;

        let MAX_SUBSCRIPTIONS : Nat = 64;
        let MAX_ID_BYTES : Nat = 64;
        let MAX_NAME_BYTES : Nat = 120;
        let MAX_COST_BYTES : Nat = 32;
        let MAX_CATEGORY_BYTES : Nat = 24;
        let MAX_CANCEL_URL_BYTES : Nat = 256;
        let MAX_NOTE_BYTES : Nat = 65_536;
        let MAX_SEATS : Nat = 8;
        let MAX_MEMBER_BYTES : Nat = 64;
        let MAX_PURGE_LOG : Nat = 64;
        let MIN_RENEW_DAYS : Nat = 1;
        let MAX_RENEW_DAYS : Nat = 3_650;
        let DAY_NS : Int = 86_400_000_000_000;

        func findSubscription(id : Text) : ?Memory.Subscription {
            Array.find<Memory.Subscription>(mem.subscriptions, func(s) { s.id == id });
        };

        func toMeta(s : Memory.Subscription) : SubscriptionMeta {
            {
                id = s.id;
                name = s.name;
                cost = s.cost;
                category = s.category;
                funded = s.funded;
                cancel_url = s.cancel_url;
                has_note = s.note_ciphertext != null;
                note_bytes = switch (s.note_ciphertext) {
                    case (?b) b.size();
                    case null 0;
                };
                renew_days = s.renew_days;
                pot_e8s = s.pot_e8s;
                payee = s.payee;
                created_at = s.created_at;
                expires_at = s.expires_at;
                seconds_left = Int.max((s.expires_at - Time.now()) / 1_000_000_000, 0);
            };
        };

        func recordPurge(id : Text, name : Text, reason : Text) {
            let event : Memory.PurgeEvent = {
                id;
                name;
                purged_at = Time.now();
                reason;
            };
            mem.purge_log := Array.concat(mem.purge_log, [event]);
            if (mem.purge_log.size() > MAX_PURGE_LOG) {
                mem.purge_log := Array.sliceToArray<Memory.PurgeEvent>(
                    mem.purge_log,
                    mem.purge_log.size() - MAX_PURGE_LOG,
                    mem.purge_log.size(),
                );
            };
        };

        func removeById(id : Text) {
            mem.subscriptions := Array.filter<Memory.Subscription>(mem.subscriptions, func(s) { s.id != id });
        };

        // Deletes every expired subscription when auto-delete is on.
        // Returns how many were purged.
        func sweepExpired() : Nat {
            if (not mem.auto_delete) return 0;
            let now = Time.now();
            let expired = Array.filter<Memory.Subscription>(mem.subscriptions, func(s) { s.expires_at <= now });
            for (s in expired.vals()) {
                removeById(s.id);
                recordPurge(s.id, s.name, "burned — never confirmed");
            };
            expired.size();
        };

        func nextExpiryIn() : ?Int {
            if (mem.subscriptions.size() == 0) return null;
            var soonest = mem.subscriptions[0].expires_at;
            for (s in mem.subscriptions.vals()) {
                if (s.expires_at < soonest) soonest := s.expires_at;
            };
            ?Int.max((soonest - Time.now()) / 1_000_000_000, 0);
        };

        public func /*query*/status() : Status {
            {
                subscription_count = mem.subscriptions.size();
                auto_delete = mem.auto_delete;
                monitor_runs = mem.monitor_runs;
                purge_count = mem.purge_log.size();
                next_expiry_in = nextExpiryIn();
                monthly_budget = mem.monthly_budget;
            };
        };

        public func /*update*/set_budget(monthly_budget : Text) : Text {
            if (monthly_budget.size() > MAX_COST_BYTES) return "Budget must be 32 characters or fewer";
            mem.monthly_budget := monthly_budget;
            if (monthly_budget == "") "Budget cleared" else "Monthly budget set to " # monthly_budget;
        };

        public func /*update*/set_funded(id : Text, funded : Bool) : Text {
            let applied = patchSubscription(id, func(s) {
                {
                    id = s.id;
                    name = s.name;
                    cost = s.cost;
                    category = s.category;
                    funded;
                    cancel_url = s.cancel_url;
                    note_ciphertext = s.note_ciphertext;
                    renew_days = s.renew_days;
                    pot_e8s = s.pot_e8s;
                    payee = s.payee;
                    created_at = s.created_at;
                    expires_at = s.expires_at;
                };
            });
            if (not applied) return "No subscription with id " # id;
            if (funded) id # " funded" else id # " unfunded";
        };

        func findSession(id : Text) : ?Memory.SplitSession {
            Array.find<Memory.SplitSession>(mem.sessions, func(s) { s.id == id });
        };

        func toSessionView(s : Memory.SplitSession) : SessionView {
            let subName = switch (findSubscription(s.sub_id)) {
                case (?sub) sub.name;
                case null s.sub_id;
            };
            {
                id = s.id;
                sub_id = s.sub_id;
                sub_name = subName;
                seats = Array.map<Memory.Seat, SeatView>(
                    s.seats,
                    func(seat) { { member = seat.member; paid = seat.paid } },
                );
                open = s.open;
                created_at = s.created_at;
            };
        };

        func addSeat(session : Memory.SplitSession, member : Text) : ?Text {
            if (not session.open) return ?"Session is closed";
            if (member.size() == 0 or member.size() > MAX_MEMBER_BYTES) return ?"Member name must be 1-64 characters";
            if (session.seats.size() >= MAX_SEATS) return ?"Session is full (8 seats)";
            switch (Array.find<Memory.Seat>(session.seats, func(seat) { seat.member == member })) {
                case (?_) return ?"That member already has a seat";
                case null {};
            };
            mem.sessions := Array.map<Memory.SplitSession, Memory.SplitSession>(
                mem.sessions,
                func(s) {
                    if (s.id != session.id) return s;
                    {
                        id = s.id;
                        sub_id = s.sub_id;
                        seats = Array.concat(s.seats, [{ member; paid = false }]);
                        open = s.open;
                        created_at = s.created_at;
                    };
                },
            );
            null;
        };

        public func /*update*/create_session(sub_id : Text, members : [Text]) : Text {
            switch (findSubscription(sub_id)) {
                case null return "No subscription with id " # sub_id;
                case (?_) {};
            };
            if (members.size() == 0) return "Name at least one member";
            if (members.size() > MAX_SEATS) return "At most 8 seats";
            let id = sub_id # "-" # Int.toText(Time.now());
            let session : Memory.SplitSession = {
                id;
                sub_id;
                seats = [];
                open = true;
                created_at = Time.now();
            };
            mem.sessions := Array.concat(mem.sessions, [session]);
            for (member in members.vals()) {
                switch (addSeat(session, member)) {
                    case (?err) return err;
                    case null {};
                };
            };
            "Split session " # id # " created with " # Nat.toText(members.size()) # " seats";
        };

        public func /*query*/list_sessions() : [SessionView] {
            Array.map<Memory.SplitSession, SessionView>(mem.sessions, toSessionView);
        };

        public func /*update*/mark_seat_paid(session_id : Text, member : Text, paid : Bool) : Text {
            switch (findSession(session_id)) {
                case null return "No session with id " # session_id;
                case (?_) {};
            };
            var found = false;
            mem.sessions := Array.map<Memory.SplitSession, Memory.SplitSession>(
                mem.sessions,
                func(s) {
                    if (s.id != session_id) return s;
                    {
                        id = s.id;
                        sub_id = s.sub_id;
                        seats = Array.map<Memory.Seat, Memory.Seat>(
                            s.seats,
                            func(seat) {
                                if (seat.member != member) return seat;
                                found := true;
                                { member = seat.member; paid };
                            },
                        );
                        open = s.open;
                        created_at = s.created_at;
                    };
                },
            );
            if (found) {
                member # (if (paid) " marked paid" else " marked unpaid");
            } else {
                "No seat for " # member;
            };
        };

        public func /*update*/close_session(session_id : Text) : Text {
            switch (findSession(session_id)) {
                case null return "No session with id " # session_id;
                case (?_) {};
            };
            mem.sessions := Array.map<Memory.SplitSession, Memory.SplitSession>(
                mem.sessions,
                func(s) {
                    if (s.id != session_id) return s;
                    {
                        id = s.id;
                        sub_id = s.sub_id;
                        seats = s.seats;
                        open = false;
                        created_at = s.created_at;
                    };
                },
            );
            "Session closed";
        };

        // Public ingress handler (route subz_split_v1/join): a friend's Neutron
        // canister claims a seat. The caller pays the route's cycle floor.
        public func /*update*/split_join(
            request : SplitJoinInput,
            /*caller*/ caller : Principal,
        ) : Text {
            ignore caller;
            switch (findSession(request.session_id)) {
                case null return "No session with id " # request.session_id;
                case (?session) {
                    switch (addSeat(session, request.member)) {
                        case (?err) err;
                        case null request.member # " joined " # request.session_id;
                    };
                };
            };
        };

        public func /*update*/add_subscription(input : AddSubscriptionInput) : Text {
            let id = input.id;
            let name = input.name;
            let cost = input.cost;
            let category = input.category;
            let funded = input.funded;
            let cancel_url = input.cancel_url;
            let note_ciphertext = input.note_ciphertext;
            let renew_days = input.renew_days;
            if (id.size() == 0 or id.size() > MAX_ID_BYTES) return "Id must be 1-64 characters";
            if (name.size() == 0 or name.size() > MAX_NAME_BYTES) return "Name must be 1-120 characters";
            if (cost.size() > MAX_COST_BYTES) return "Cost must be 32 characters or fewer";
            if (category.size() > MAX_CATEGORY_BYTES) return "Category must be 24 characters or fewer";
            if (cancel_url.size() > MAX_CANCEL_URL_BYTES) return "Cancel URL must be 256 characters or fewer";
            if (renew_days < MIN_RENEW_DAYS or renew_days > MAX_RENEW_DAYS) return "Renewal must be 1-3650 days";
            switch (note_ciphertext) {
                case (?b) {
                    if (b.size() == 0 or b.size() > MAX_NOTE_BYTES) return "Note ciphertext must be 1-65536 bytes";
                };
                case null {};
            };
            if (mem.subscriptions.size() >= MAX_SUBSCRIPTIONS) return "Vault full (64 subscriptions)";
            switch (findSubscription(id)) {
                case (?_) return "A subscription with this id already exists";
                case null {};
            };
            let now = Time.now();
            let entry : Memory.Subscription = {
                id;
                name;
                cost;
                category;
                funded;
                cancel_url;
                note_ciphertext;
                renew_days;
                pot_e8s = 0;
                payee = "";
                created_at = now;
                expires_at = now + Int.fromNat(renew_days) * DAY_NS;
            };
            mem.subscriptions := Array.concat(mem.subscriptions, [entry]);
            "Stored " # id # " — renews in " # Nat.toText(renew_days) # " days unless you keep it";
        };

        func patchSubscription(id : Text, patch : Memory.Subscription -> Memory.Subscription) : Bool {
            var found = false;
            mem.subscriptions := Array.map<Memory.Subscription, Memory.Subscription>(
                mem.subscriptions,
                func(s) {
                    if (s.id != id) return s;
                    found := true;
                    patch(s);
                },
            );
            found;
        };

        func extendExpiry(s : Memory.Subscription) : Memory.Subscription {
            {
                id = s.id;
                name = s.name;
                cost = s.cost;
                category = s.category;
                funded = s.funded;
                cancel_url = s.cancel_url;
                note_ciphertext = s.note_ciphertext;
                renew_days = s.renew_days;
                pot_e8s = s.pot_e8s;
                payee = s.payee;
                created_at = s.created_at;
                expires_at = Time.now() + Int.fromNat(s.renew_days) * DAY_NS;
            };
        };

        public func /*update*/extend_subscription(id : Text) : Text {
            if (not patchSubscription(id, extendExpiry)) return "No subscription with id " # id;
            "Kept " # id;
        };

        public func /*update*/update_subscription(input : UpdateSubscriptionInput) : Text {
            let id = input.id;
            let name = input.name;
            let cost = input.cost;
            let category = input.category;
            let cancel_url = input.cancel_url;
            let renew_days = input.renew_days;
            if (name.size() == 0 or name.size() > MAX_NAME_BYTES) return "Name must be 1-120 characters";
            if (cost.size() > MAX_COST_BYTES) return "Cost must be 32 characters or fewer";
            if (category.size() > MAX_CATEGORY_BYTES) return "Category must be 24 characters or fewer";
            if (cancel_url.size() > MAX_CANCEL_URL_BYTES) return "Cancel URL must be 256 characters or fewer";
            if (renew_days < MIN_RENEW_DAYS or renew_days > MAX_RENEW_DAYS) return "Renewal must be 1-3650 days";
            // Editing details never touches the fuse — expiry stays as it was.
            let applied = patchSubscription(id, func(s) {
                {
                    id = s.id;
                    name;
                    cost;
                    category;
                    funded = s.funded;
                    cancel_url;
                    note_ciphertext = s.note_ciphertext;
                    renew_days;
                    pot_e8s = s.pot_e8s;
                    payee = s.payee;
                    created_at = s.created_at;
                    expires_at = s.expires_at;
                };
            });
            if (not applied) return "No subscription with id " # id;
            "Updated " # id;
        };

        public func /*update*/set_payee(id : Text, payee : Text) : Text {
            if (payee.size() > MAX_PAYEE_BYTES) return "Payee must be 128 characters or fewer";
            let applied = patchSubscription(id, func(s) {
                {
                    id = s.id;
                    name = s.name;
                    cost = s.cost;
                    category = s.category;
                    funded = s.funded;
                    cancel_url = s.cancel_url;
                    note_ciphertext = s.note_ciphertext;
                    renew_days = s.renew_days;
                    pot_e8s = s.pot_e8s;
                    payee;
                    created_at = s.created_at;
                    expires_at = s.expires_at;
                };
            });
            if (not applied) return "No subscription with id " # id;
            if (payee == "") "Payee cleared for " # id else "Payee set for " # id;
        };

        public func /*update*/fund_pot(id : Text, amount_e8s : Nat) : Text {
            let applied = patchSubscription(id, func(s) {
                {
                    id = s.id;
                    name = s.name;
                    cost = s.cost;
                    category = s.category;
                    funded = true;
                    cancel_url = s.cancel_url;
                    note_ciphertext = s.note_ciphertext;
                    renew_days = s.renew_days;
                    pot_e8s = s.pot_e8s + amount_e8s;
                    payee = s.payee;
                    created_at = s.created_at;
                    expires_at = s.expires_at;
                };
            });
            if (not applied) return "No subscription with id " # id;
            "Pot for " # id # " now holds " # Nat.toText(amount_e8s) # " more e8s";
        };

        func clearPot(id : Text) {
            ignore patchSubscription(id, func(s) {
                {
                    id = s.id;
                    name = s.name;
                    cost = s.cost;
                    category = s.category;
                    funded = false;
                    cancel_url = s.cancel_url;
                    note_ciphertext = s.note_ciphertext;
                    renew_days = s.renew_days;
                    pot_e8s = 0;
                    payee = s.payee;
                    created_at = s.created_at;
                    expires_at = s.expires_at;
                };
            });
        };

        public func /*update*/vault_balance() : async* BalanceView {
            let ledger = Principal.fromText(ICP_LEDGER);
            let account : IcrcAccount = {
                owner = backendCalls.canister_principal;
                subaccount = null;
            };
            if (not backendCalls.can_call(ledger, "icrc1_balance_of")) {
                return { ok = false; message = "Reserve icrc1_balance_of on the ICP ledger first"; balance_e8s = 0 };
            };
            switch (await* backendCalls.call({
                canister = ledger;
                method = "icrc1_balance_of";
                args = to_candid (account);
                cycles = 0;
            })) {
                case (#err(error)) {
                    { ok = false; message = "Ledger call failed (" # error.code # ")"; balance_e8s = 0 };
                };
                case (#ok(reply)) {
                    let decoded : ?Nat = from_candid reply;
                    switch (decoded) {
                        case (?balance) ({ ok = true; message = ""; balance_e8s = balance });
                        case null ({ ok = false; message = "Ledger returned an unreadable balance"; balance_e8s = 0 });
                    };
                };
            };
        };

        // Pays out the sub's pot to its payee, then counts as keeping the sub:
        // the fuse resets on a successful transfer.
        public func /*update*/pay_now(id : Text) : async* PayResult {
            let sub = switch (findSubscription(id)) {
                case null return { ok = false; message = "No subscription with id " # id; block_index = null; pot_e8s = 0 };
                case (?s) s;
            };
            if (sub.pot_e8s == 0) return { ok = false; message = "Pot is empty"; block_index = null; pot_e8s = 0 };
            if (sub.payee == "") return { ok = false; message = "Set a payee principal first"; block_index = null; pot_e8s = sub.pot_e8s };
            if (sub.pot_e8s <= LEDGER_FEE_E8S) return { ok = false; message = "Pot must exceed the 0.0001 ICP ledger fee"; block_index = null; pot_e8s = sub.pot_e8s };
            let payeePrincipal = try {
                Principal.fromText(sub.payee);
            } catch (_cause) {
                return { ok = false; message = "Payee is not a valid principal"; block_index = null; pot_e8s = sub.pot_e8s };
            };
            let ledger = Principal.fromText(ICP_LEDGER);
            if (not backendCalls.can_call(ledger, "icrc1_transfer")) {
                return { ok = false; message = "Reserve icrc1_transfer on the ICP ledger first"; block_index = null; pot_e8s = sub.pot_e8s };
            };
            let args : IcrcTransferArgs = {
                from_subaccount = null;
                to = { owner = payeePrincipal; subaccount = null };
                amount = sub.pot_e8s - LEDGER_FEE_E8S;
                fee = ?LEDGER_FEE_E8S;
                memo = null;
                created_at_time = null;
            };
            switch (await* backendCalls.call({
                canister = ledger;
                method = "icrc1_transfer";
                args = to_candid (args);
                cycles = 0;
            })) {
                case (#err(error)) {
                    { ok = false; message = "Transfer failed (" # error.code # ")"; block_index = null; pot_e8s = sub.pot_e8s };
                };
                case (#ok(reply)) {
                    let decoded : ?IcrcTransferResult = from_candid reply;
                    switch (decoded) {
                        case (?#Ok(blockIndex)) {
                            clearPot(id);
                            ignore patchSubscription(id, extendExpiry);
                            ({ ok = true; message = "Paid in ledger block " # Nat.toText(blockIndex) # " — fuse reset"; block_index = ?blockIndex; pot_e8s = 0 });
                        };
                        case (?#Err(_)) {
                            ({ ok = false; message = "Ledger rejected the transfer (check canister balance)"; block_index = null; pot_e8s = sub.pot_e8s });
                        };
                        case null {
                            ({ ok = false; message = "Ledger returned an unreadable result"; block_index = null; pot_e8s = sub.pot_e8s });
                        };
                    };
                };
            };
        };

        public func /*update*/delete_subscription(id : Text) : Text {
            switch (findSubscription(id)) {
                case null return "No subscription with id " # id;
                case (?s) {
                    removeById(id);
                    recordPurge(id, s.name, "cancelled by owner");
                    "Cancelled " # id;
                };
            };
        };

        public func /*query*/list_subscriptions() : [SubscriptionMeta] {
            Array.map<Memory.Subscription, SubscriptionMeta>(mem.subscriptions, toMeta);
        };

        public func /*query*/purge_log() : [PurgeEventView] {
            Array.map<Memory.PurgeEvent, PurgeEventView>(
                mem.purge_log,
                func(e) {
                    {
                        id = e.id;
                        name = e.name;
                        purged_at = e.purged_at;
                        reason = e.reason;
                    };
                },
            );
        };

        public func /*query*/get_key(id : Text) : ?Blob {
            switch (findSubscription(id)) {
                case (?s) s.note_ciphertext;
                case null null;
            };
        };

        public func /*update*/set_policy(auto_delete : Bool) : Text {
            mem.auto_delete := auto_delete;
            if (auto_delete) "Auto-burn on: unconfirmed subscriptions are removed" else "Auto-burn paused — expired subscriptions are kept";
        };

        public func /*update*/purge_now() : Text {
            let n = sweepExpired();
            "Burned " # Nat.toText(n) # " expired subscription(s)";
        };

        public func /*update*/sign_purge_receipt() : async* Receipt {
            let assertionText =
                "subZ purge receipt v1\n" #
                "purge_count=" # Nat.toText(mem.purge_log.size()) # "\n" #
                "active_subscriptions=" # Nat.toText(mem.subscriptions.size()) # "\n" #
                "signed_at=" # Int.toText(Time.now());
            switch (await* chainKeySigning.sign_assertion({
                slot = "purge_receipts";
                assertion = Text.encodeUtf8(assertionText);
            })) {
                case (#ok(info)) {
                    {
                        ok = true;
                        error = "";
                        assertion_text = assertionText;
                        signature_hex = "0x" # hex(info.signature);
                    };
                };
                case (#err(error)) {
                    {
                        ok = false;
                        error = chainKeyErrorText(error);
                        assertion_text = assertionText;
                        signature_hex = "";
                    };
                };
            };
        };

        public func /*internal*/expiry_monitor(
            (),
            /*task_capabilities*/ taskCapabilities : TaskCapabilities,
        ) : async* () {
            ignore taskCapabilities.backend_calls.canister_principal;
            mem.monitor_runs += 1;
            ignore sweepExpired();
        };

        func hex(b : Blob) : Text {
            let digits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
            var out = "";
            for (byte in b.vals()) {
                let hi = Nat8.toNat(byte) / 16;
                let lo = Nat8.toNat(byte) % 16;
                out := out # Text.fromChar(digits[hi]) # Text.fromChar(digits[lo]);
            };
            out;
        };

        func chainKeyErrorText(
            error : NeutronCapabilities.ChainKeySigningErrorV1,
        ) : Text {
            switch (error) {
                case (#invalid_request) "The assertion request is invalid";
                case (#not_declared) "The purge receipt slot is not declared";
                case (#disabled) "Purge receipt signing is disabled in Neutron settings";
                case (#busy) "The chain-key service is busy";
                case (#cost_too_high) "The threshold-key quote exceeds Neutron's per-call cost ceiling";
                case (#low_cycles) "Chain-key signing is unavailable because Neutron cycles are low";
                case (#key_unavailable) "The configured threshold key is unavailable on this network";
                case (#management_failure) "The threshold-key request failed";
                case (#outcome_unknown) "The signing outcome is unknown; reconcile by reading status";
                case (#source_gone) "The requesting source disappeared before signing completed";
                case (#revoked_after_dispatch) "Signing authority was revoked after dispatch; reconcile by reading status";
            };
        };

    };

/*---NEUTRON GENERATED BEGIN---*/

public type status_Input = ();
public type status_Output = Status;

public type set_budget_Input = (monthly_budget : Text);
public type set_budget_Output = Text;

public type set_funded_Input = (id : Text, funded : Bool);
public type set_funded_Output = Text;

public type create_session_Input = (sub_id : Text, members : [Text]);
public type create_session_Output = Text;

public type list_sessions_Input = ();
public type list_sessions_Output = [SessionView];

public type mark_seat_paid_Input = (session_id : Text, member : Text, paid : Bool);
public type mark_seat_paid_Output = Text;

public type close_session_Input = (session_id : Text);
public type close_session_Output = Text;

public type split_join_Input = (request : SplitJoinInput);
public type split_join_Output = Text;

public type add_subscription_Input = (input : AddSubscriptionInput);
public type add_subscription_Output = Text;

public type extend_subscription_Input = (id : Text);
public type extend_subscription_Output = Text;

public type update_subscription_Input = (input : UpdateSubscriptionInput);
public type update_subscription_Output = Text;

public type set_payee_Input = (id : Text, payee : Text);
public type set_payee_Output = Text;

public type fund_pot_Input = (id : Text, amount_e8s : Nat);
public type fund_pot_Output = Text;

public type vault_balance_Input = ();
public type vault_balance_Output = BalanceView;

public type pay_now_Input = (id : Text);
public type pay_now_Output = PayResult;

public type delete_subscription_Input = (id : Text);
public type delete_subscription_Output = Text;

public type list_subscriptions_Input = ();
public type list_subscriptions_Output = [SubscriptionMeta];

public type purge_log_Input = ();
public type purge_log_Output = [PurgeEventView];

public type get_key_Input = (id : Text);
public type get_key_Output = ?Blob;

public type set_policy_Input = (auto_delete : Bool);
public type set_policy_Output = Text;

public type purge_now_Input = ();
public type purge_now_Output = Text;

public type sign_purge_receipt_Input = ();
public type sign_purge_receipt_Output = Receipt;

public type expiry_monitor_Input = (());
public type expiry_monitor_Output = ();

/*---NEUTRON GENERATED END---*/
}
