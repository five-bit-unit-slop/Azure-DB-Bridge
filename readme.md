## TODO - Source code structure

The source code must be split into separate modules, each with a clearly defined responsibility.

### `src/`
- [ ] `index.js` - Initialize and configure Azure Functions.
- [ ] `functions/database.js` - Register the HTTP trigger and route incoming requests to the correct handlers.

### `src/handlers/`
- [ ] `deviceHandler.js` - Handle device-related HTTP actions, such as listing devices.
- [ ] `measurementHandler.js` - Handle measurement-related HTTP actions, such as creating and listing measurements.

### `src/services/`
- [ ] `deviceService.js` - Implement device-related business logic.
- [ ] `measurementService.js` - Implement measurement-related business logic.

### `src/database/`
- [ ] `connection.js` - Configure and manage Azure SQL connections and authentication.
- [ ] `gatewayRepository.js` - Handle database queries for gateways.
- [ ] `deviceRepository.js` - Handle database queries for devices.
- [ ] `sensorRepository.js` - Handle database queries for sensors.
- [ ] `measurementRepository.js` - Handle database queries for measurements.

### `src/validation/`
- [ ] `deviceValidation.js` - Validate device-related input.
- [ ] `measurementValidation.js` - Validate measurement payloads and their fields.

### `src/utils/`
- [ ] `responses.js` - Provide reusable HTTP response helpers for success and error responses.

### Cleanup and verification
- [ ] Move all existing functionality from `httpTrigger1.js` into the appropriate modules.
- [ ] Update imports and exports.
- [ ] Remove `httpTrigger1.js` after the migration is complete.
- [ ] Ensure there is only one registration for the `database` HTTP trigger.
- [ ] Run `npm test` and verify that all existing tests pass.
- [ ] Test the Azure Function locally with `func start`.