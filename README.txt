BK EXCLUSIVEZ — V24

WHAT'S NEW
- Private Admin Login at /admin
- Admin dashboard for bookings, airport quote requests, pending holds and blocked times
- Admin can confirm/cancel requests and manually block unavailable time
- Airport Pickup / Drop-Off never collects a deposit and is stored as a quote request
- Black Truck Service uses a $100 confirmation deposit in the customer flow
- Customer availability reads from the server; do not open index.html directly with file://

RUN LOCALLY
1. Install Node.js 18+.
2. Open a terminal in this folder.
3. Run: node server.js
4. Open: http://localhost:3000
5. Admin: http://localhost:3000/admin

INITIAL ADMIN LOGIN
Username: admin
Password: BKExclusivez!2026

SECURITY BEFORE PUBLIC LAUNCH
Change these environment variables on your host:
ADMIN_USERNAME=your-admin-username
ADMIN_PASSWORD=your-strong-password
NODE_ENV=production
Do not put Square secrets or access tokens in index.html or script.js.

IMPORTANT FOR PUBLIC HOSTING
V24 currently stores booking data in data/reservations.json so it is easy to test. Free web hosts such as Render can use temporary files, so this JSON store should be replaced with Supabase/PostgreSQL before relying on it for real customer bookings. The admin UI is already structured for that next step.

SQUARE
Square webhook/payment integration is not yet live in V24. Sandbox should be connected and tested before switching to Production.
