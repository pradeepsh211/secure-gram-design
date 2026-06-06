-- 1) PROFILES: hide phone from other users
DROP POLICY IF EXISTS "profiles readable by authenticated" ON public.profiles;

CREATE POLICY "users read own profile"
ON public.profiles FOR SELECT TO authenticated
USING (auth.uid() = id);

CREATE OR REPLACE VIEW public.public_profiles
WITH (security_invoker = false) AS
SELECT id, name, avatar_url, role, district, state
FROM public.profiles;

GRANT SELECT ON public.public_profiles TO authenticated, anon;

-- 2) BIDS: restrict visibility to bidder + auction seller
DROP POLICY IF EXISTS "bids readable by authenticated" ON public.bids;

CREATE POLICY "bidder reads own bids"
ON public.bids FOR SELECT TO authenticated
USING (auth.uid() = bidder_id);

CREATE POLICY "auction seller reads bids on own auctions"
ON public.bids FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.auctions a
  WHERE a.id = bids.auction_id AND a.seller_id = auth.uid()
));

CREATE OR REPLACE VIEW public.auction_bid_counts
WITH (security_invoker = false) AS
SELECT auction_id, COUNT(*)::int AS bid_count
FROM public.bids
GROUP BY auction_id;

GRANT SELECT ON public.auction_bid_counts TO authenticated;

-- 3) TRANSACTIONS INSERT: validate seller matches listing/auction owner
DROP POLICY IF EXISTS "buyers create transactions" ON public.transactions;

CREATE POLICY "buyers create valid transactions"
ON public.transactions FOR INSERT TO authenticated
WITH CHECK (
  auth.uid() = buyer_id
  AND auth.uid() <> seller_id
  AND (
    (listing_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.listings l
      WHERE l.id = listing_id AND l.seller_id = transactions.seller_id
    ))
    OR
    (auction_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.auctions a
      WHERE a.id = auction_id AND a.seller_id = transactions.seller_id
    ))
  )
);

-- 4) TRANSACTIONS UPDATE: prevent tampering of money/identity fields
CREATE OR REPLACE FUNCTION public.prevent_transaction_field_tampering()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.amount      IS DISTINCT FROM OLD.amount
     OR NEW.buyer_id  IS DISTINCT FROM OLD.buyer_id
     OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
     OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
     OR NEW.auction_id IS DISTINCT FROM OLD.auction_id
  THEN
    RAISE EXCEPTION 'Only the status field may be updated on a transaction';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_transaction_tamper ON public.transactions;
CREATE TRIGGER trg_prevent_transaction_tamper
BEFORE UPDATE ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.prevent_transaction_field_tampering();