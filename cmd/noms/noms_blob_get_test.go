// Copyright 2016 Attic Labs, Inc. All rights reserved.
// Licensed under the Apache License, version 2.0:
// http://www.apache.org/licenses/LICENSE-2.0

package main

import (
	"bytes"
	"context"
	"fmt"
	"io/ioutil"
	"path/filepath"
	"testing"

	"github.com/attic-labs/noms/go/spec"
	"github.com/attic-labs/noms/go/types"
	"github.com/attic-labs/noms/go/util/clienttest"
	"github.com/stretchr/testify/suite"
)

func TestNomsBlobGet(t *testing.T) {
	suite.Run(t, &nbeSuite{})
}

type nbeSuite struct {
	clienttest.ClientTestSuite
}

func (s *nbeSuite) TestNomsBlobGet() {
	sp, err := spec.ForDatabase(s.TempDir)
	s.NoError(err)
	defer sp.Close()
	db := sp.GetDatabase()

	blobBytes := []byte("hello")
	blob := types.NewBlob(context.Background(), db, bytes.NewBuffer(blobBytes))

	ref := db.WriteValue(context.Background(), blob)
	_, err = db.CommitValue(db.GetDataset("datasetID"), ref)
	s.NoError(err)

	hashSpec := fmt.Sprintf("%s::#%s", s.TempDir, ref.TargetHash().String())
	filePath := filepath.Join(s.TempDir, "out")
	s.MustRun(main, []string{"blob", "export", hashSpec, filePath})

	fileBytes, err := ioutil.ReadFile(filePath)
	s.NoError(err)
	s.Equal(blobBytes, fileBytes)

	stdout, _ := s.MustRun(main, []string{"blob", "export", hashSpec})
	fmt.Println("stdout:", stdout)
	s.Equal(blobBytes, []byte(stdout))
}
