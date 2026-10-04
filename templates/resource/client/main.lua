local resource = GetCurrentResourceName()

-- The page gets its strings from the same file Lua reads, so there is one place to translate.
Nexus.locale(json.decode(LoadResourceFile(resource, 'locales/en.json')))

RegisterCommand('{{name}}', function()
    Nexus.open('main', { name = GetPlayerName(PlayerId()) })
end, false)
