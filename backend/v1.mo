// Persistent schema: keep this file immutable after release. Package imports are
// allowed; relative imports are forbidden so app-local types cannot drift.
module {
    public type Subscription = {
        id : Text;
        name : Text;
        cost : Text;
        cancel_url : Text;
        note_ciphertext : ?Blob;
        renew_days : Nat;
        created_at : Int;
        expires_at : Int;
    };

    public type PurgeEvent = {
        id : Text;
        name : Text;
        purged_at : Int;
        reason : Text;
    };

    public type Mem = {
        var subscriptions : [Subscription];
        var purge_log : [PurgeEvent];
        var auto_delete : Bool;
        var monitor_runs : Nat;
    };

    public func init() : Mem {
        {
            var subscriptions = [];
            var purge_log = [];
            var auto_delete = true;
            var monitor_runs = 0;
        };
    };
};
