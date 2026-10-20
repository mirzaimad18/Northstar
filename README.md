# Northstar Supply

A single-page e-commerce storefront built with HTML, CSS, and vanilla JavaScript, backed by an Express API and SQLite.

## Run locally

1. Install Node.js and npm.
2. Install dependencies with `npm install`.
3. Start the API with `npm start`. It listens on `http://localhost:5000` and initializes `store.db` with four sample products when the products table is empty.
4. In a second terminal, serve `index.html` with `python -m http.server 8000`. Open `http://localhost:8000`.

The frontend calls the API at `http://localhost:5000/api`. Serve the page over HTTP during development so browser origin and CORS behavior match a deployed frontend.

## Development checks

Run the automated API checks with `npm test`. The suite uses a temporary SQLite database and does not modify the local store database.

## Store features

- Search and sort the product collection.
- Open a shareable product detail view from each product card.
- Adjust cart quantities; the cart is saved in browser local storage.
- Register or sign in to associate orders with an account, or check out as a guest.
- Account-linked orders use short-lived server-side bearer sessions; signing out invalidates the session.
- Persist products, users, and orders in SQLite.

## API

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/products` | List products |
| `GET` | `/api/products/:id` | Get product details |
| `POST` | `/api/register` | Create an account |
| `POST` | `/api/login` | Verify an account |
| `POST` | `/api/logout` | Invalidate the current bearer session |
| `POST` | `/api/orders` | Place an order; send a bearer token for an account order or omit it for guest checkout |

## Prototype scope

This is a local learning project, not a production commerce platform. Bearer sessions are stored in memory and expire after 12 hours; a server restart invalidates them. Before deployment, persist sessions securely, add request throttling, inventory reservation, payment-provider integration, and production HTTPS/configuration.
