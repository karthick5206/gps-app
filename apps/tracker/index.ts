// The background location task must be defined at the top level of the bundle, before the router loads,
// so it is registered when Android starts the app headless (app closed) to deliver locations.
import './src/lib/task';
import 'expo-router/entry';
