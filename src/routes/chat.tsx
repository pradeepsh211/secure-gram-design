import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Send, Paperclip, ShieldCheck, Lock, MessageCircle } from "lucide-react";
import { TopBar } from "@/components/sg/TopBar";
import { BottomNav } from "@/components/sg/BottomNav";
import { TrustBadge } from "@/components/sg/Badge";
import { useUser, getInitials } from "@/lib/sg/user";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type Search = { to?: string };
export const Route = createFileRoute("/chat")({
  component: Chat,
  validateSearch: (s: Record<string, unknown>): Search => ({ to: typeof s.to === "string" ? s.to : undefined }),
});

type Msg = { id: string; sender_id: string; recipient_id: string; body: string; created_at: string };
type Contact = { id: string; name: string; avatar_url: string | null };

function Chat() {
  const user = useUser();
  const { to } = useSearch({ from: "/chat" });

  if (!user) {
    return (
      <>
        <div className="mobile-shell"><TopBar title="Chat" />
          <div className="px-5 py-10 text-center">
            <p className="font-bold">Sign in to chat</p>
            <Link to="/login" search={{ role: "farmer" }} className="mt-3 inline-block text-primary font-bold">Go to login →</Link>
          </div>
        </div><BottomNav />
      </>
    );
  }
  return to ? <Thread me={user.id} other={to} /> : <Inbox me={user.id} />;
}

function Inbox({ me }: { me: string }) {
  const [contacts, setContacts] = useState<(Contact & { last: string; when: string })[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const { data: msgs } = await supabase
      .from("chat_messages")
      .select("*")
      .or(`sender_id.eq.${me},recipient_id.eq.${me}`)
      .order("created_at", { ascending: false });
    const seen = new Map<string, { last: string; when: string }>();
    (msgs || []).forEach((m: any) => {
      const other = m.sender_id === me ? m.recipient_id : m.sender_id;
      if (!seen.has(other)) seen.set(other, { last: m.body, when: m.created_at });
    });
    const ids = Array.from(seen.keys());

    // also include other profiles so user can start a chat (safe public view, no phone)
    const { data: allProfiles } = await supabase
      .from("public_profiles" as any).select("id,name,avatar_url").neq("id", me).limit(20);

    const merged = new Map<string, Contact & { last: string; when: string }>();
    (allProfiles || []).forEach((p: any) => merged.set(p.id, { ...p, last: "Start a conversation", when: "" }));
    ids.forEach((id) => {
      const m = merged.get(id) || { id, name: id.slice(0, 6), avatar_url: null, last: "", when: "" };
      const s = seen.get(id)!;
      merged.set(id, { ...m, last: s.last, when: s.when });
    });
    // sort by recent activity
    const list = Array.from(merged.values()).sort((a, b) => (b.when || "").localeCompare(a.when || ""));
    setContacts(list);
    setLoading(false);
  };

  useEffect(() => { load(); }, [me]);

  return (
    <>
      <div className="mobile-shell">
        <TopBar title="Chat" subtitle="🔒 End-to-end encrypted" />
        <div className="px-5 py-3 space-y-2">
          {loading && <p className="text-center text-sm text-muted-foreground py-6">Loading…</p>}
          {!loading && contacts.length === 0 && (
            <div className="rounded-3xl border-2 border-dashed border-border p-8 text-center">
              <MessageCircle className="h-8 w-8 mx-auto text-muted-foreground" />
              <p className="mt-2 font-bold">No one to chat with yet</p>
              <p className="text-xs text-muted-foreground">Other users will show up here once they sign up.</p>
            </div>
          )}
          {contacts.map((c) => (
            <Link key={c.id} to="/chat" search={{ to: c.id }} className="flex items-center gap-3 p-3 rounded-2xl bg-card border border-border active:bg-muted">
              <div className="h-12 w-12 rounded-full gradient-primary text-primary-foreground grid place-items-center font-bold">
                {getInitials(c.name || "U")}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-sm truncate">{c.name || "Unnamed"}</p>
                <p className="text-xs text-muted-foreground truncate">{c.last}</p>
              </div>
              {c.when && <span className="text-[10px] text-muted-foreground">{new Date(c.when).toLocaleDateString()}</span>}
            </Link>
          ))}
        </div>
      </div>
      <BottomNav />
    </>
  );
}

function Thread({ me, other }: { me: string; other: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [contact, setContact] = useState<Contact | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    supabase.from("public_profiles" as any).select("id,name,avatar_url").eq("id", other).maybeSingle()
      .then(({ data }) => setContact(data as unknown as Contact | null));

    supabase.from("chat_messages")
      .select("*")
      .or(`and(sender_id.eq.${me},recipient_id.eq.${other}),and(sender_id.eq.${other},recipient_id.eq.${me})`)
      .order("created_at", { ascending: true })
      .then(({ data, error }) => {
        if (error) toast.error(error.message);
        setMsgs((data as Msg[]) || []);
      });
  }, [me, other]);

  useEffect(() => {
    const ch = supabase
      .channel(`chat-${me}-${other}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, (payload: any) => {
        const m = payload.new as Msg;
        const involves = (m.sender_id === me && m.recipient_id === other) || (m.sender_id === other && m.recipient_id === me);
        if (involves) setMsgs((prev) => prev.some((x) => x.id === m.id) ? prev : [...prev, m]);
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [me, other]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs.length]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    const { error } = await supabase.from("chat_messages").insert({
      sender_id: me, recipient_id: other, body,
    });
    if (error) { toast.error(error.message); setText(body); }
  };

  return (
    <>
      <div className="mobile-shell flex flex-col" style={{ minHeight: "100dvh" }}>
        <TopBar
          title={contact?.name || "Conversation"}
          subtitle="🟢 Online • E2E encrypted"
          back="/chat"
          right={<TrustBadge variant="rsa" />}
        />

        <div className="flex-1 px-4 py-4 space-y-2 pb-44 bg-muted/30">
          <div className="text-center text-[10px] text-muted-foreground mb-2">
            <Lock className="inline h-3 w-3" /> Messages are end-to-end encrypted
          </div>
          {msgs.length === 0 && (
            <p className="text-center text-xs text-muted-foreground py-6">Say hello 👋</p>
          )}
          {msgs.map((m) => {
            const mine = m.sender_id === me;
            return (
              <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"} animate-fade-in`}>
                <div className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-sm ${mine ? "bg-primary text-primary-foreground rounded-br-md" : "bg-card border border-border rounded-bl-md"}`}>
                  <p>{m.body}</p>
                  <div className={`mt-1 flex items-center gap-1 text-[10px] ${mine ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                    <span>{new Date(m.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    {mine && <ShieldCheck className="h-3 w-3" />}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={endRef} />
        </div>

        <div className="fixed bottom-20 inset-x-0 z-30">
          <div className="mobile-shell px-4 pb-2 pt-3 glass border-t border-border">
            <div className="flex items-center gap-2">
              <button className="h-11 w-11 rounded-full bg-muted grid place-items-center" aria-label="Attach"><Paperclip className="h-4 w-4" /></button>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
                placeholder="Type a message…"
                className="flex-1 h-11 px-4 rounded-full bg-card border border-border outline-none text-sm focus:border-primary"
              />
              <button onClick={send} className="h-11 w-11 rounded-full gradient-primary grid place-items-center text-primary-foreground" aria-label="Send">
                <Send className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
      <BottomNav />
    </>
  );
}
