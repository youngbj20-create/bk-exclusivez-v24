-- Run once in Supabase SQL Editor before deploying the notification update.
ALTER TABLE public.reservations
ADD COLUMN IF NOT EXISTS customer_email text;

-- The previous approval update also requires this column.
ALTER TABLE public.reservations
ADD COLUMN IF NOT EXISTS square_payment_url text;
