# reading-tracker

Track what you read from the command line.

```
reading-tracker add <title>    # add a book
reading-tracker list           # one line per entry, open/done
reading-tracker finish <id>    # mark an entry done
reading-tracker --version      # print the version and exit
```

Entries are stored as JSON in `.reading-tracker.json` in the working
directory; set `READING_TRACKER_FILE` to use another path.

Run the tests with `npm test` (plain `node --test`, no dependencies).
