-- The one thing the screen on the prop asks the server: the time. An answer on the screen means
-- that a call made it from a display to client Lua, to the server and back.
Nexus.handle('worldtest:time', function()
    return { time = os.date('%H:%M:%S') }
end)
