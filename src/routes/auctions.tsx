import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Clock, Gavel, ShieldCheck, Loader2, Check, AlertCircle, Tag, TrendingUp, Users, Plus, X } from "lucide-react";
import { TopBar } from "@/components/sg/TopBar";
import { BottomNav } from "@/components/sg/BottomNav";
import { celebrate } from "@/lib/sg/confetti";
import { useUser } from "@/lib/sg/user";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/auctions")({ component: Auctions });

const MIN_INCREMENT = 500;

type AuctionRow = {
  id: string;
  title: string;
  crop: string;
  quantity_quintal: number;
  starting_price: number;
  current_price: number;
  closes_at: string;
  seller_id: string;
  status: string;
};

function useCountdown(closesAt: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = Math.max(0, Math.floor((new Date(closesAt).getTime() - now) / 1000));
  const h = Math.floor(remaining / 3600), m = Math.floor((remaining % 3600) / 60), s = remaining % 60;
  return { label: `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`, remaining };
}

function Auctions() {
  const user = useUser();
  const navigate = useNavigate();
  const [auctions, setAuctions] = useState<AuctionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [bidCounts, setBidCounts] = useState<Record<string, number>>({});
  const [showCreate, setShowCreate] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("auctions")
      .select("*")
      .eq("status", "active")
      .order("closes_at", { ascending: true });
    if (error) { toast.error(error.message); setLoading(false); return; }
    setAuctions((data as AuctionRow[]) || []);
    // bid counts via safe aggregate view
    const ids = (data || []).map((a: any) => a.id);
    if (ids.length) {
      const { data: countRows } = await supabase
        .from("auction_bid_counts" as any)
        .select("auction_id,bid_count")
        .in("auction_id", ids);
      const counts: Record<string, number> = {};
      (countRows || []).forEach((b: any) => { counts[b.auction_id] = b.bid_count; });
      setBidCounts(counts);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  // Realtime: bump current_price when new bid
  useEffect(() => {
    const ch = supabase
      .channel("auctions-feed")
      .on("postgres_changes", { event: "*", schema: "public", table: "auctions" }, () => load())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "bids" }, (payload: any) => {
        const aid = payload.new.auction_id;
        setBidCounts((c) => ({ ...c, [aid]: (c[aid] || 0) + 1 }));
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  return (
    <>
      <div className="mobile-shell">
        <TopBar
          title="Procurement Auctions"
          subtitle="Live bidding • RSA-signed"
          right={user && (
            <button
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-1.5 rounded-full gradient-action text-action-foreground"
            >
              <Plus className="h-3 w-3" /> New
            </button>
          )}
        />
        <div className="px-5 py-4 space-y-4">
          {!user && (
            <div className="rounded-2xl border border-border bg-card p-4 text-sm">
              <p className="font-semibold">Sign in to bid</p>
              <button onClick={() => navigate({ to: "/login", search: { role: "buyer" } })} className="mt-2 text-primary font-bold text-xs">Go to login →</button>
            </div>
          )}
          {loading && <p className="text-center text-sm text-muted-foreground py-8">Loading auctions…</p>}
          {!loading && auctions.length === 0 && (
            <div className="rounded-3xl border-2 border-dashed border-border p-8 text-center">
              <Gavel className="h-8 w-8 mx-auto text-muted-foreground" />
              <p className="mt-2 font-bold">No live auctions</p>
              <p className="text-xs text-muted-foreground">{user ? "Be the first to start one." : "Sign in to start one."}</p>
              {user && (
                <button onClick={() => setShowCreate(true)} className="mt-3 px-4 py-2 rounded-xl gradient-primary text-primary-foreground font-bold text-sm inline-flex items-center gap-1.5">
                  <Plus className="h-4 w-4" /> Create auction
                </button>
              )}
            </div>
          )}
          {auctions.map((a) => (
            <AuctionCard
              key={a.id}
              auction={a}
              bidCount={bidCounts[a.id] || 0}
              userId={user?.id}
              onBid={async () => { await load(); }}
            />
          ))}
        </div>
      </div>
      <BottomNav />
      {showCreate && user && (
        <CreateAuctionSheet
          userId={user.id}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); load(); }}
        />
      )}
    </>
  );
}

function AuctionCard({ auction, bidCount, userId, onBid }: { auction: AuctionRow; bidCount: number; userId?: string; onBid: () => void }) {
  const { label, remaining } = useCountdown(auction.closes_at);
  const minNext = auction.current_price + MIN_INCREMENT;
  const [bid, setBid] = useState(minNext);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "signing" | "done">("idle");

  useEffect(() => { setBid((b) => (b < minNext ? minNext : b)); }, [minNext]);

  const sellerPrice = auction.starting_price;
  const progress = Math.min(100, Math.round((auction.current_price / sellerPrice) * 100));
  const closed = remaining === 0 || auction.status !== "active";

  const submit = async () => {
    setError(null);
    if (!userId) { setError("Sign in to bid"); return; }
    if (auction.seller_id === userId) { setError("You can't bid on your own auction"); return; }
    if (bid < minNext) { setError(`Minimum next bid is ₹${minNext.toLocaleString()}`); return; }
    setState("signing");
    const { error: e } = await supabase.from("bids").insert({
      auction_id: auction.id,
      bidder_id: userId,
      amount: bid,
    });
    if (e) { setState("idle"); toast.error(e.message); return; }
    setState("done");
    celebrate();
    toast.success("Bid placed and RSA-signed");
    onBid();
    setTimeout(() => setState("idle"), 1800);
  };

  return (
    <div className="rounded-3xl border p-4 shadow-card bg-card border-border">
      <div className="flex items-start gap-3">
        <div className="h-14 w-14 rounded-2xl bg-muted grid place-items-center text-3xl">🌾</div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold leading-tight">{auction.title}</h3>
          <p className="text-[11px] text-muted-foreground">{auction.crop} • {auction.quantity_quintal} quintal</p>
          <div className="mt-2 flex items-center gap-3 text-[11px] font-semibold">
            <span className={`inline-flex items-center gap-1 ${closed ? "text-destructive" : "text-action"}`}><Clock className="h-3.5 w-3.5" />{closed ? "Closed" : label}</span>
            <span className="text-muted-foreground inline-flex items-center gap-1"><Users className="h-3 w-3" />{bidCount} bids</span>
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-2xl p-3 border" style={{ background: "color-mix(in oklab, oklch(0.6 0.12 240) 10%, transparent)", borderColor: "color-mix(in oklab, oklch(0.6 0.12 240) 30%, transparent)" }}>
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide font-bold" style={{ color: "oklch(0.5 0.14 240)" }}>
            <Tag className="h-3 w-3" /> Start Price
          </div>
          <p className="mt-1 text-lg font-bold" style={{ color: "oklch(0.45 0.14 240)" }}>₹{sellerPrice.toLocaleString()}</p>
        </div>
        <div className="rounded-2xl p-3 border bg-primary/10 border-primary/30">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide font-bold text-primary">
            <TrendingUp className="h-3 w-3" /> Current Bid
          </div>
          <p className="mt-1 text-lg font-bold text-primary">₹{auction.current_price.toLocaleString()}</p>
          <p className="text-[10px] text-muted-foreground">Min next: ₹{minNext.toLocaleString()}</p>
        </div>
      </div>

      <div className="mt-3">
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div className="h-full gradient-primary transition-all duration-700" style={{ width: `${progress}%` }} />
        </div>
      </div>

      {error && (
        <div className="mt-3 flex items-center gap-1.5 rounded-xl bg-destructive/10 text-destructive px-3 py-2 text-[11px] font-semibold">
          <AlertCircle className="h-3.5 w-3.5" /> {error}
        </div>
      )}

      <div className="mt-3 flex items-end gap-2">
        <div className="flex-1">
          <label className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Your bid (₹)</label>
          <input
            type="number"
            value={bid}
            min={minNext}
            step={MIN_INCREMENT}
            disabled={closed}
            onChange={e => { setError(null); setBid(Number(e.target.value)); }}
            className="mt-1 w-full h-11 px-3 rounded-xl bg-card border border-border outline-none text-sm font-semibold focus:border-primary disabled:opacity-50"
          />
        </div>
        <button
          onClick={submit}
          disabled={state !== "idle" || closed}
          className="h-11 px-4 rounded-xl gradient-action text-action-foreground font-bold text-sm shadow-card active:scale-[0.97] transition flex items-center gap-1.5 disabled:opacity-60"
        >
          {state === "idle" && (<><Gavel className="h-4 w-4" />Bid</>)}
          {state === "signing" && (<><Loader2 className="h-4 w-4 animate-spin" />Signing</>)}
          {state === "done" && (<><Check className="h-4 w-4 animate-check-pop" />Placed</>)}
        </button>
      </div>
      {state === "done" && (
        <div className="mt-3 flex items-center gap-1.5 text-[11px] text-primary font-semibold">
          <ShieldCheck className="h-3.5 w-3.5" /> Bid signed with your private key
        </div>
      )}
    </div>
  );
}

function CreateAuctionSheet({ userId, onClose, onCreated }: { userId: string; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [crop, setCrop] = useState("Paddy Seeds");
  const [qty, setQty] = useState(10);
  const [start, setStart] = useState(2000);
  const [hours, setHours] = useState(24);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!title.trim()) { toast.error("Add a title"); return; }
    setSaving(true);
    const closesAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    const { error } = await supabase.from("auctions").insert({
      seller_id: userId,
      title: title.trim(),
      crop,
      quantity_quintal: qty,
      starting_price: start,
      current_price: start,
      closes_at: closesAt,
    });
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Auction created");
    onCreated();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 grid place-items-end animate-fade-in" onClick={onClose}>
      <div className="mobile-shell w-full" onClick={(e) => e.stopPropagation()}>
        <div className="rounded-t-3xl bg-card p-6 animate-slide-up space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold">New auction</h3>
            <button onClick={onClose} className="h-9 w-9 rounded-full bg-muted grid place-items-center"><X className="h-4 w-4" /></button>
          </div>
          <Input label="Title" value={title} onChange={setTitle} placeholder="e.g. BPT-5204 Paddy Seeds" />
          <Input label="Crop / Item" value={crop} onChange={setCrop} />
          <div className="grid grid-cols-2 gap-3">
            <NumInput label="Quantity (q)" value={qty} onChange={setQty} />
            <NumInput label="Start price (₹)" value={start} onChange={setStart} />
          </div>
          <NumInput label="Closes in (hours)" value={hours} onChange={setHours} />
          <button onClick={save} disabled={saving} className="w-full h-12 rounded-2xl gradient-primary text-primary-foreground font-bold disabled:opacity-60 flex items-center justify-center gap-2">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Create & sign
          </button>
        </div>
      </div>
    </div>
  );
}

function Input({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="mt-1 w-full h-11 px-3 rounded-xl bg-background border border-border outline-none text-sm focus:border-primary" />
    </label>
  );
}
function NumInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{label}</span>
      <input type="number" value={value} onChange={(e) => onChange(Number(e.target.value) || 0)} className="mt-1 w-full h-11 px-3 rounded-xl bg-background border border-border outline-none text-sm font-semibold focus:border-primary" />
    </label>
  );
}
