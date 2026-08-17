import Array "mo:core/Array";
import Char "mo:core/Char";
import Int "mo:core/Int";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
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
            chain_key_signing : NeutronCapabilities.ChainKeySigningV1;
        };
    };

    public class Init(env : AppBackendEnvironment) {
        let mem = env.stable_memory.subz;
        let chainKeySigning = env.capabilities.chain_key_signing;

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
            switch (findSubscription(id)) {
                case null return "No subscription with id " # id;
                case (?_) {};
            };
            mem.subscriptions := Array.map<Memory.Subscription, Memory.Subscription>(
                mem.subscriptions,
                func(s) {
                    if (s.id != id) return s;
                    {
                        id = s.id;
                        name = s.name;
                        cost = s.cost;
                        category = s.category;
                        funded;
                        cancel_url = s.cancel_url;
                        note_ciphertext = s.note_ciphertext;
                        renew_days = s.renew_days;
                        created_at = s.created_at;
                        expires_at = s.expires_at;
                    };
                },
            );
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

        public func /*update*/add_subscription(
            id : Text,
            name : Text,
            cost : Text,
            category : Text,
            funded : Bool,
            cancel_url : Text,
            note_ciphertext : ?Blob,
            renew_days : Nat,
        ) : Text {
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
                created_at = now;
                expires_at = now + Int.fromNat(renew_days) * DAY_NS;
            };
            mem.subscriptions := Array.concat(mem.subscriptions, [entry]);
            "Stored " # id # " — renews in " # Nat.toText(renew_days) # " days unless you keep it";
        };

        public func /*update*/extend_subscription(id : Text) : Text {
            switch (findSubscription(id)) {
                case null return "No subscription with id " # id;
                case (?s) {};
            };
            mem.subscriptions := Array.map<Memory.Subscription, Memory.Subscription>(
                mem.subscriptions,
                func(s) {
                    if (s.id != id) return s;
                    {
                        id = s.id;
                        name = s.name;
                        cost = s.cost;
                        category = s.category;
                        funded = s.funded;
                        cancel_url = s.cancel_url;
                        note_ciphertext = s.note_ciphertext;
                        renew_days = s.renew_days;
                        created_at = s.created_at;
                        expires_at = Time.now() + Int.fromNat(s.renew_days) * DAY_NS;
                    };
                },
            );
            "Kept " # id;
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

public type add_subscription_Input = (id : Text,
            name : Text,
            cost : Text,
            category : Text,
            funded : Bool,
            cancel_url : Text,
            note_ciphertext : ?Blob,
            renew_days : Nat,);
public type add_subscription_Output = Text;

public type extend_subscription_Input = (id : Text);
public type extend_subscription_Output = Text;

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
