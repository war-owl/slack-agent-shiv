# Database access

How to answer a question from the analytics database.

This is an example Skill, and it is also the real shape of one — adapt the connection
variable and the table notes to your own database, or delete the file if you have none.

## The connection

The connection string is in the environment variable `ANALYTICS_DATABASE_URL`. It is
already set in your environment; you do not need to ask for it and you must not print it,
copy it into a Note, or paste it into the thread.

The role it authenticates as is **read-only**. `INSERT`, `UPDATE`, `DELETE` and DDL will
be refused by the server, so do not try to work around a failure that says permission
denied — that is the intended answer, and the interesting thing to report is what you
were trying to do and why.

## Running a query

Use `psql` and let it do the formatting:

```sh
psql "$ANALYTICS_DATABASE_URL" --no-psqlrc --csv -c "select count(*) from orders"
```

- `--csv` because you are usually about to compute something from the result rather than
  read it, and CSV is what a script wants. Drop it when the answer *is* the table and it
  is small enough to paste into Slack, where the aligned default reads better.
- `--no-psqlrc` so a developer's local `.psqlrc` cannot change what your query returns.
- Always `LIMIT` an exploratory query. Some of these tables have hundreds of millions of
  rows and a bare `select *` will sit there until something times out.

For anything beyond a single aggregate, write the query to a `.sql` file in your
workspace and run it with `-f`. It is easier to correct than a long `-c` string, and it
means the thread's record of what you did includes the query itself.

## Finding your way around

There is no ERD. Start here:

```sh
psql "$ANALYTICS_DATABASE_URL" --no-psqlrc -c "\dt"
psql "$ANALYTICS_DATABASE_URL" --no-psqlrc -c "\d+ orders"
```

Two things about this database that are not guessable and have caught people out:

- **It is a replica, and it lags.** Usually seconds, occasionally minutes. Anything you
  say about "right now" is approximate, and a question about the last few minutes is one
  to answer with a caveat rather than a number.
- **Money is in minor units** — `amount_cents`, integers. Dividing by 100 in the query
  and rounding is the difference between an answer and an answer that is out by two
  decimal places.
- **Soft deletes are real.** Most tables have `deleted_at`, and rows with it set are still
  there. Almost every count you are asked for wants `where deleted_at is null`.

## Reporting the answer

Say what you counted and over what window, not just the number — "4,182 orders in the
last 7 days, excluding soft-deleted rows" rather than "4182". Include the query if the
answer is surprising, because the first thing a reader will want to check is whether you
asked the right question.

If the replica's lag matters to the answer, say so.
