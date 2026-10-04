-- `data` has already passed the contract in web/contract.ts: it is a table with a `name` of 1 to
-- 24 characters and nothing else. `source` comes from the server, never from the page.
Nexus.handle('greet', function(source, data)
    return {
        message = ('Hello %s. The server knows you as player %d.'):format(data.name, source),
    }
end)
