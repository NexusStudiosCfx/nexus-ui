-- A small JSON codec for the tests. It behaves like the one in FiveM where that matters to the
-- bridge: null becomes nil (so it vanishes from tables), arrays are 1-based, and an empty table
-- is encoded as [].

local json = {}

local escapes = { ['"'] = '"', ['\\'] = '\\', ['/'] = '/', b = '\b', f = '\f', n = '\n', r = '\r', t = '\t' }

local function decodeError(text, at, what)
    error(('json: %s at %d in %s'):format(what, at, text:sub(1, 60)))
end

local function skip(text, at)
    return text:find('[^ \t\r\n]', at) or #text + 1
end

-- A lone surrogate has no UTF-8 form. It is written the way a lenient encoder would, as three
-- bytes, which is exactly what utf8.len refuses.
local function codepoint(code)
    if code >= 0xD800 and code <= 0xDFFF then
        return string.char(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 0x3F), 0x80 | (code & 0x3F))
    end
    return utf8.char(code)
end

local decodeValue

local function decodeString(text, at)
    local parts = {}
    local i = at + 1
    while true do
        local stop = text:find('["\\]', i)
        if not stop then decodeError(text, at, 'unterminated string') end
        parts[#parts + 1] = text:sub(i, stop - 1)
        if text:sub(stop, stop) == '"' then
            return table.concat(parts), stop + 1
        end
        local kind = text:sub(stop + 1, stop + 1)
        if kind == 'u' then
            local code = tonumber(text:sub(stop + 2, stop + 5), 16)
            i = stop + 6
            if code >= 0xD800 and code <= 0xDBFF and text:sub(i, i + 1) == '\\u' then
                local low = tonumber(text:sub(i + 2, i + 5), 16)
                if low >= 0xDC00 and low <= 0xDFFF then
                    code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00)
                    i = i + 6
                end
            end
            parts[#parts + 1] = codepoint(code)
        else
            parts[#parts + 1] = escapes[kind] or decodeError(text, stop, 'bad escape')
            i = stop + 2
        end
    end
end

local function decodeNumber(text, at)
    local stop = text:find('[^%d%.eE%+%-]', at) or #text + 1
    local literal = text:sub(at, stop - 1)
    local value = literal:find('[%.eE]') and tonumber(literal) or math.tointeger(tonumber(literal)) or tonumber(literal)
    if value == nil then decodeError(text, at, 'bad number') end
    return value, stop
end

local function decodeArray(text, at)
    local result = {}
    local index = 0
    local i = skip(text, at + 1)
    if text:sub(i, i) == ']' then return result, i + 1 end
    while true do
        local value
        value, i = decodeValue(text, i)
        index = index + 1
        result[index] = value
        i = skip(text, i)
        local char = text:sub(i, i)
        if char == ']' then return result, i + 1 end
        if char ~= ',' then decodeError(text, i, 'expected , or ]') end
        i = skip(text, i + 1)
    end
end

local function decodeObject(text, at)
    local result = {}
    local i = skip(text, at + 1)
    if text:sub(i, i) == '}' then return result, i + 1 end
    while true do
        if text:sub(i, i) ~= '"' then decodeError(text, i, 'expected a key') end
        local key
        key, i = decodeString(text, i)
        i = skip(text, i)
        if text:sub(i, i) ~= ':' then decodeError(text, i, 'expected :') end
        local value
        value, i = decodeValue(text, skip(text, i + 1))
        result[key] = value
        i = skip(text, i)
        local char = text:sub(i, i)
        if char == '}' then return result, i + 1 end
        if char ~= ',' then decodeError(text, i, 'expected , or }') end
        i = skip(text, i + 1)
    end
end

function decodeValue(text, at)
    local char = text:sub(at, at)
    if char == '{' then return decodeObject(text, at) end
    if char == '[' then return decodeArray(text, at) end
    if char == '"' then return decodeString(text, at) end
    if text:sub(at, at + 3) == 'true' then return true, at + 4 end
    if text:sub(at, at + 4) == 'false' then return false, at + 5 end
    if text:sub(at, at + 3) == 'null' then return nil, at + 4 end
    return decodeNumber(text, at)
end

function json.decode(text)
    local value, stop = decodeValue(text, skip(text, 1))
    if skip(text, stop) <= #text then decodeError(text, stop, 'trailing characters') end
    return value
end

local function encodeString(value)
    return '"' .. value:gsub('[%c"\\]', function(char)
        if char == '"' then return '\\"' end
        if char == '\\' then return '\\\\' end
        return ('\\u%04x'):format(char:byte())
    end) .. '"'
end

local function isArray(value)
    local count = 0
    for _ in pairs(value) do count = count + 1 end
    for i = 1, count do
        if value[i] == nil then return false end
    end
    return true
end

function json.encode(value)
    local kind = type(value)
    if kind == 'nil' then return 'null' end
    if kind == 'boolean' then return tostring(value) end
    if kind == 'string' then return encodeString(value) end
    if kind == 'number' then
        if math.type(value) == 'integer' then return tostring(value) end
        if value ~= value or value == math.huge or value == -math.huge then return 'null' end
        if value == math.floor(value) and math.abs(value) < 2 ^ 53 then return ('%d'):format(value) end
        return ('%.17g'):format(value)
    end
    if kind ~= 'table' then return encodeString('<' .. kind .. '>') end
    local parts = {}
    if isArray(value) then
        for i = 1, #value do parts[i] = json.encode(value[i]) end
        return '[' .. table.concat(parts, ',') .. ']'
    end
    local keys = {}
    for key in pairs(value) do keys[#keys + 1] = tostring(key) end
    table.sort(keys)
    for i = 1, #keys do
        local key = keys[i]
        local item = value[key]
        if item == nil then item = value[tonumber(key)] end
        parts[i] = encodeString(key) .. ':' .. json.encode(item)
    end
    return '{' .. table.concat(parts, ',') .. '}'
end

return json
