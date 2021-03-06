import firebase from "firebase/app";
import "firebase/auth";
import DefaultMethods from "./methods";

import {
  GET_LIST,
  GET_ONE,
  GET_MANY,
  GET_MANY_REFERENCE,
  CREATE,
  UPDATE,
  DELETE
} from "admin-on-rest";

/**
 * @param {string[]|Object[]} trackedResources Array of resource names or array of Objects containing name and
 * optional path properties (path defaults to name)
 * @param {Object} firebaseConfig Options Firebase configuration
 */

const BaseConfiguration = {
  initialQueryTimeout: 1000,
  timestampFieldNames: {
    createdAt: "createdAt",
    updatedAt: "updatedAt"
  },
  firebasePersistence: firebase.auth.Auth.Persistence.SESSION
};

const resourcesStatus = {};
const resourcesReferences = {};
const resourcesData = {};
const resourcesPaths = {};
const resourcesUploadFields = {};
const globalMethods = {};

const initializeResource = async ({ name, isPublic }, initialQueryTimeout) => {
  let ref = (resourcesReferences[name] = firebase
    .database()
    .ref(resourcesPaths[name]));
  resourcesData[name] = [];

  if (isPublic) {
    await subscribeResource(ref, name);
  } else {
    firebase.auth().onAuthStateChanged(auth => {
      if (auth) {
        subscribeResource(ref, name);
      }
    });
  }

  await new Promise(r => setTimeout(r, initialQueryTimeout));
};

const sanitizeResource = resource => {
  if (typeof resource === "string") {
    resource = {
      name: resource
    };
  }

  const { name, path, uploadFields } = resource;

  if (!resource.name) {
    throw new Error(`name is missing from resource ${resource}`);
  }

  resourcesUploadFields[name] = uploadFields || [];
  resourcesPaths[name] = path || "/" + name;
  resourcesData[name] = {};

  return resource;
};

const subscribeResource = async (ref, name) => {
  const snapshot = await ref.orderByKey().once("value");
  const entries = snapshot.val() || {};

  let lastId = "";

  Object.keys(entries).map(id => {
    resourcesData[name][id] = globalMethods.postRead(
      { ...entries[id], id },
      id,
      name
    );
    lastId = id;
  });

  ref
    .orderByKey()
    .startAt(lastId)
    .on("child_added", childSnapshot => {
      const id = childSnapshot.key;
      resourcesData[name][id] = globalMethods.postRead(
        { ...childSnapshot.val(), id },
        id,
        name
      );
    });

  ref.on("child_changed", childSnapshot => {
    const id = childSnapshot.key;
    resourcesData[name][id] = globalMethods.postRead(
      { ...childSnapshot.val(), id },
      id,
      name
    );
  });

  ref.on("child_removed", oldChildSnapshot => {
    const id = oldChildSnapshot.key;
    delete resourcesData[name][id];
  });
};

export default (firebaseConfig = {}, { trackedResources, options }) => {
  options = Object.assign({}, BaseConfiguration, options || {});
  const { timestampFieldNames, initialQueryTimeout } = options;

  if (firebase.apps.length === 0) {
    firebase.initializeApp(firebaseConfig);
    firebase.auth().setPersistence(options.firebasePersistence);
  }

  /* InternalMethods */
  const methods = Object.assign({}, DefaultMethods, options.methods || {});

  globalMethods.preSave = methods.preSave;
  globalMethods.postRead = methods.postRead;

  // Sanitize Resources
  trackedResources.map(resource => {
    resource = sanitizeResource(resource);

    resourcesStatus[resource.name] = initializeResource(
      resource,
      initialQueryTimeout
    );
  });

  /**
   * @param {string} type Request type, e.g GET_LIST
   * @param {string} resourceName Resource name, e.g. "posts"
   * @param {Object} payload Request parameters. Depends on the request type
   * @returns {Promise} the Promise for a REST response
   */

  return async (type, resourceName, params) => {
    await resourcesStatus[resourceName];
    let result = null;

    switch (type) {
      case GET_LIST:
      case GET_MANY:
      case GET_MANY_REFERENCE:
        result = await methods.getMany(
          params,
          resourcesData[resourceName],
          type
        );
        return result;

      case GET_ONE:
        return methods.getOne(params, resourcesData[resourceName]);

      case DELETE:
        result = await methods.del(
          params,
          resourcesPaths[resourceName],
          (resourcesUploadFields[resourceName] || [])
        );
        return result;

      case UPDATE:
      case CREATE:
        params.__id = methods.getId(
          params,
          resourcesData[resourceName],
          type,
          resourcesPaths[resourceName]
        );

        result = await methods.save(
          params,
          resourceName,
          type,
          resourcesPaths[resourceName],
          globalMethods.preSave,
          resourcesUploadFields[resourceName].map(field => methods.upload(field, params, resourceName, resourcesPaths[resourceName])),
          timestampFieldNames
        );
        return result;

      default:
        // eslint-disable-next-line no-console
        console.error("Undocumented method: ", type);
        return { data: [] };
    }
  };
};
